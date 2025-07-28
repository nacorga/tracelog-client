import { ConfigManager, SessionManager, EventManager, TrackingManager, DataSender, UrlManager } from './modules';
import { Config, EventType, MetadataType, EventHandler, DeviceType } from './types';
import { NavigationData } from './events';
import { log } from './utils/logger';

enum InitializationState {
  UNINITIALIZED = 'uninitialized',
  INITIALIZING = 'initializing',
  INITIALIZED = 'initialized',
  FAILED = 'failed',
}

const createCleanupHandler = (tracker: Tracking): (() => void) => {
  return () => {
    if (tracker.isInitialized) {
      tracker.cleanup();
    }
  };
};

export class Tracking {
  public isInitialized = false;
  public isExcludedUser = false;

  private readonly initializationPromise: Promise<void>;

  private cleanupListeners: (() => void)[] = [];
  private initializationState: InitializationState = InitializationState.UNINITIALIZED;
  private configManager!: ConfigManager;
  private sessionManager!: SessionManager;
  private eventManager!: EventManager;
  private trackingManager!: TrackingManager;
  private dataSender!: DataSender;
  private urlManager!: UrlManager;

  constructor(config: Config) {
    this.initializationPromise = this.initializeTracking(config).catch((error) => {
      log('error', `Initialization rejected: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private async initializeTracking(config: Config): Promise<void> {
    if (this.initializationState !== InitializationState.UNINITIALIZED) {
      return this.initializationPromise;
    }

    this.initializationState = InitializationState.INITIALIZING;

    try {
      this.configManager = new ConfigManager();

      const mergedConfig = await this.configManager.loadConfig(config || {});
      const apiUrl = this.configManager.isDemoMode() ? 'demo' : this.configManager.getApiUrl();

      if (!apiUrl) {
        throw new Error('Failed to get API URL');
      }

      this.dataSender = new DataSender(apiUrl, () => mergedConfig.qaMode || false, this.configManager.isDemoMode());

      this.sessionManager = new SessionManager(
        mergedConfig,
        this.handleSessionEvent,
        () => mergedConfig.qaMode || false,
      );

      this.eventManager = new EventManager(
        mergedConfig,
        () => this.sessionManager.getUserId(),
        () => this.sessionManager.getSessionId(),
        () => this.sessionManager.getDevice(),
        () => this.sessionManager.getGlobalMetadata(),
        (body) => this.dataSender.sendEventsQueue(body),
        () => mergedConfig.qaMode || false,
        () => !this.sessionManager.isSampledUser(),
        (url: string) => this.urlManager?.isRouteExcluded(url) || false,
      );

      this.urlManager = new UrlManager(mergedConfig, this.handlePageViewEvent, this.handleNavigationChange, () =>
        this.trackingManager?.suppressNextScrollEvent(),
      );

      this.trackingManager = new TrackingManager(mergedConfig, this.handleTrackingEvent, this.handleInactivity);

      await this.startInitializationSequence();

      this.isExcludedUser = !this.sessionManager.isSampledUser();
      this.isInitialized = true;
      this.initializationState = InitializationState.INITIALIZED;

      if (this.isQaModeSync()) {
        log('error', 'Initialization completed successfully');
      }
    } catch (error) {
      this.initializationState = InitializationState.FAILED;

      throw error;
    }
  }

  private async startInitializationSequence(): Promise<void> {
    try {
      await this.dataSender.recoverPersistedEvents(this.sessionManager.getUserId());

      const hadUnexpectedEnd = this.sessionManager.checkForUnexpectedSessionEnd();

      if (hadUnexpectedEnd) {
        this.handleSessionEvent(EventType.SESSION_END, 'unexpected_recovery');
      }

      this.urlManager.initialize();
      this.trackingManager.initScrollTracking();
      this.trackingManager.initInactivityTracking();
      this.trackingManager.initClickTracking();
      this.setupCleanupListeners();
    } catch (error) {
      log('error', `Initialization sequence failed: ${error instanceof Error ? error.message : 'Unknown error'}`);

      throw error;
    }
  }

  private setupCleanupListeners(): void {
    const cleanup = createCleanupHandler(this);

    const beforeUnloadCleanup = (): void => {
      this.sessionManager?.setPageUnloading(true);
      cleanup();
    };

    const pageHideCleanup = (): void => {
      this.sessionManager?.setPageUnloading(true);
      cleanup();
    };

    const unloadCleanup = (): void => {
      this.sessionManager?.setPageUnloading(true);
      cleanup();
    };

    const visibilityChangeCleanup = (): void => {
      if (document.visibilityState === 'hidden') {
        this.handleInactivity(true);
        this.forceImmediateSend();
      } else {
        this.handleInactivity(false);
      }
    };

    window.addEventListener('beforeunload', beforeUnloadCleanup);
    window.addEventListener('pagehide', pageHideCleanup);
    window.addEventListener('unload', unloadCleanup);
    document.addEventListener('visibilitychange', visibilityChangeCleanup);

    this.cleanupListeners.push(
      () => window.removeEventListener('beforeunload', beforeUnloadCleanup),
      () => window.removeEventListener('pagehide', pageHideCleanup),
      () => window.removeEventListener('unload', unloadCleanup),
      () => document.removeEventListener('visibilitychange', visibilityChangeCleanup),
    );
  }

  private handleSessionEvent = (eventType: EventType, trigger?: string): void => {
    this.eventManager.handleEvent({
      evType: eventType,
      url: this.urlManager?.getCurrentUrl(),
      ...(trigger && { trigger }),
    });
  };

  private handlePageViewEvent = (fromUrl: string, toUrl: string, referrer?: string, utm?: any): void => {
    this.eventManager.handleEvent({
      evType: EventType.PAGE_VIEW,
      url: toUrl,
      fromUrl,
      ...(referrer && { referrer }),
      ...(utm && { utm }),
    });

    this.eventManager.updatePageUrl(toUrl);
  };

  private handleNavigationChange = (data: NavigationData): void => {
    const fromExcluded = this.urlManager.isRouteExcluded(data.fromUrl);
    const toExcluded = this.urlManager.isRouteExcluded(data.toUrl);

    this.eventManager.updatePageUrl(data.toUrl);

    if (fromExcluded !== toExcluded) {
      this.eventManager.logTransition({
        from: data.fromUrl,
        to: data.toUrl,
        type: toExcluded ? 'toExcluded' : 'fromExcluded',
      });
    }

    if (toExcluded) {
      this.sessionManager.pauseSession();
    } else {
      if (!this.sessionManager.hasSessionStarted()) {
        this.sessionManager.startSession();
      } else if (this.sessionManager.isPaused()) {
        this.sessionManager.resumeSession();
      }
    }
  };

  private handleTrackingEvent = (event: EventHandler): void => {
    this.eventManager.handleEvent(event);
  };

  private isQaModeSync(): boolean {
    return this.configManager?.getConfig()?.qaMode || false;
  }

  private handleInactivity = async (isInactive: boolean): Promise<void> => {
    if (isInactive) {
      this.sessionManager.handleInactivity(true);
    } else {
      this.sessionManager.handleInactivity(false);
    }
  };

  async customEventHandler(name: string, metadata?: Record<string, MetadataType>): Promise<void> {
    await this.waitForInitialization();

    if (!this.isInitialized || this.isExcludedUser) {
      return;
    }

    this.eventManager.customEventHandler(name, metadata);
  }

  async startSession(): Promise<void> {
    await this.waitForInitialization();

    if (!this.isInitialized) {
      return;
    }

    this.sessionManager.startSession();
  }

  async endSession(): Promise<void> {
    await this.waitForInitialization();

    if (!this.isInitialized) {
      return;
    }

    this.sessionManager.endSession('manual');
  }

  async getSessionId(): Promise<string> {
    await this.waitForInitialization();

    if (!this.isInitialized) {
      return '';
    }

    return this.sessionManager?.getSessionId() || '';
  }

  async getUserId(): Promise<string> {
    await this.waitForInitialization();

    if (!this.isInitialized) {
      return '';
    }

    return this.sessionManager?.getUserId() || '';
  }

  async forceImmediateSend(): Promise<void> {
    await this.waitForInitialization();

    if (!this.isInitialized) {
      return;
    }

    const events = this.eventManager.getEventsQueue();

    if (events.length > 0) {
      const finalBatch = {
        user_id: this.sessionManager.getUserId(),
        session_id: this.sessionManager.getSessionId() || '',
        device: this.sessionManager.getDevice() || DeviceType.Desktop,
        events: events,
        ...(this.sessionManager.getGlobalMetadata() && { global_metadata: this.sessionManager.getGlobalMetadata() }),
      };

      this.dataSender.sendEventsSynchronously(finalBatch);
      this.eventManager.clearEventsQueue();
    }
  }

  async suppressNextScrollEvent(): Promise<void> {
    await this.waitForInitialization();

    if (!this.isInitialized) {
      return;
    }

    this.trackingManager.suppressNextScrollEvent();
  }

  async updateUrl(url: string): Promise<void> {
    await this.waitForInitialization();

    if (!this.isInitialized) {
      return;
    }

    this.urlManager.updateUrl(url);
    this.eventManager.updatePageUrl(url);
  }

  async getConfig(): Promise<Config | undefined> {
    await this.waitForInitialization();
    return this.configManager?.getConfig();
  }

  async isQaMode(): Promise<boolean> {
    await this.waitForInitialization();
    return this.configManager?.getConfig()?.qaMode || false;
  }

  cleanup(): void {
    if (!this.isInitialized) {
      return;
    }

    try {
      this.sessionManager?.endSession('page_unload');
      this.forceImmediateSendSync();
      this.urlManager?.cleanup();
      this.trackingManager?.cleanup();
      this.sessionManager?.cleanup();
      this.eventManager?.cleanup();
      this.dataSender?.cleanup();

      for (const cleanup of this.cleanupListeners) {
        try {
          cleanup();
        } catch (error) {
          if (this.isQaModeSync()) {
            log('error', `Error removing event listener: ${error instanceof Error ? error.message : 'Unknown error'}`);
          }
        }
      }

      this.cleanupListeners = [];
      this.isInitialized = false;
      this.isExcludedUser = false;
    } catch (error) {
      if (this.isQaModeSync()) {
        log('error', `Cleanup error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }
  }

  private forceImmediateSendSync(): void {
    if (!this.isInitialized) {
      return;
    }

    const events = this.eventManager.getEventsQueue();

    if (events.length > 0) {
      const finalBatch = {
        user_id: this.sessionManager.getUserId(),
        session_id: this.sessionManager.getSessionId() || '',
        device: this.sessionManager.getDevice() || DeviceType.Desktop,
        events: events,
        ...(this.sessionManager.getGlobalMetadata() && { global_metadata: this.sessionManager.getGlobalMetadata() }),
      };

      const success = this.dataSender.sendEventsSynchronously(finalBatch);

      if (!success) {
        this.dataSender.persistCriticalEvents(finalBatch);
      }

      this.eventManager.clearEventsQueue();
    }
  }

  private async waitForInitialization(): Promise<void> {
    if (this.initializationState === InitializationState.INITIALIZED) {
      return;
    }

    if (this.initializationState === InitializationState.FAILED) {
      throw new Error('Initialization failed, cannot perform operation');
    }

    if (this.initializationState === InitializationState.INITIALIZING) {
      try {
        await this.initializationPromise;
      } catch {
        throw new Error('Initialization failed during wait');
      }
    }

    if (this.initializationState === InitializationState.UNINITIALIZED) {
      throw new Error('Not initialized');
    }
  }
}
