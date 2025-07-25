import { Config } from '../types';
import { DEFAULT_API_CONFIG, SESSION_TIMEOUT_DEFAULT_MS, SESSION_TIMEOUT_MIN_MS } from '../constants';
import { IConfigValidator } from './config-validator';
import { IConfigFetcher } from './config-fetcher';
import { isValidUrl } from '../utils';
import { Base } from '../base';

export abstract class ConfigLoader {
  abstract load(config: Config): Promise<Config>;
}

export class DemoConfigLoader extends ConfigLoader {
  async load(config: Config): Promise<Config> {
    return {
      ...DEFAULT_API_CONFIG,
      ...config,
      qaMode: true,
      samplingRate: 1,
      tags: [],
      excludedUrlPaths: [],
    };
  }
}

export class CustomApiConfigLoader extends Base implements ConfigLoader {
  constructor(
    private readonly validator: IConfigValidator,
    private readonly fetcher: IConfigFetcher,
  ) {
    super();
  }

  async load(config: Config): Promise<Config> {
    const { remoteConfigApiUrl } = config;

    let merged: Config = {
      ...DEFAULT_API_CONFIG,
      ...config,
    };

    await this.validateAndReport(config);

    if (remoteConfigApiUrl) {
      try {
        const remote = await this.fetcher.fetch(config);

        if (remote) {
          merged = { ...merged, ...remote };
        }
      } catch (error) {
        throw new Error(`Custom config fetch failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    return this.applyCorrections(merged);
  }

  private async validateAndReport(config: Config): Promise<void> {
    const result = this.validator.validate(config);

    if (result.errors.length > 0) {
      throw new Error(`Configuration errors: ${result.errors.join('; ')}`);
    }

    if (result.warnings.length > 0) {
      this.log('warning', `Configuration warnings: ${result.warnings.join('; ')}`);
    }
  }

  private applyCorrections(config: Config): Config {
    const corrected = { ...config };

    if (typeof corrected.samplingRate !== 'number' || corrected.samplingRate < 0 || corrected.samplingRate > 1) {
      corrected.samplingRate = 1;
    }

    if (!Array.isArray(corrected.excludedUrlPaths)) {
      corrected.excludedUrlPaths = [];
    }

    if (typeof corrected.sessionTimeout !== 'number' || corrected.sessionTimeout < SESSION_TIMEOUT_MIN_MS) {
      corrected.sessionTimeout = SESSION_TIMEOUT_DEFAULT_MS;
    }

    if (corrected.apiUrl) {
      try {
        const url = new URL(corrected.apiUrl);
        const sanitized = url.href.replace(/\/$/, '');

        corrected.apiUrl = isValidUrl(sanitized, url.hostname, corrected.allowHttp) ? sanitized : undefined;
      } catch {
        corrected.apiUrl = undefined;
      }
    }

    if (corrected.remoteConfigApiUrl) {
      try {
        const url = new URL(corrected.remoteConfigApiUrl);
        corrected.remoteConfigApiUrl = url.href.replace(/\/$/, '');
      } catch {
        corrected.remoteConfigApiUrl = undefined;
      }
    }

    return corrected;
  }
}

export class StandardConfigLoader extends Base implements ConfigLoader {
  constructor(
    private readonly validator: IConfigValidator,
    private readonly fetcher: IConfigFetcher,
  ) {
    super();
  }

  async load(config: Config): Promise<Config> {
    if (!config.id) {
      throw new Error('Tracking ID is required when not using apiUrl');
    }

    const errors: string[] = [];
    const warnings: string[] = [];

    let finalConfig: Config = {
      ...DEFAULT_API_CONFIG,
      ...config,
    };

    try {
      const validationResult = this.validator.validate(config);

      errors.push(...validationResult.errors);
      warnings.push(...validationResult.warnings);
    } catch (error) {
      errors.push(`Failed to validate app config: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    try {
      const remoteConfig = await this.fetcher.fetch(config);

      if (remoteConfig) {
        finalConfig = { ...finalConfig, ...remoteConfig };
      } else {
        warnings.push('Failed to load remote configuration, using defaults');
      }
    } catch (error) {
      errors.push(`Remote config fetch failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    if (warnings.length > 0) {
      this.log('warning', `Configuration warnings: ${warnings.join('; ')}`);
    }

    if (errors.length > 0) {
      throw new Error(`Configuration errors: ${errors.join('; ')}`);
    }

    return this.applyCorrections(finalConfig);
  }

  private applyCorrections(config: Config): Config {
    const corrected = { ...config };

    if (typeof corrected.samplingRate !== 'number' || corrected.samplingRate < 0 || corrected.samplingRate > 1) {
      corrected.samplingRate = 1;
    }

    if (!Array.isArray(corrected.excludedUrlPaths)) {
      corrected.excludedUrlPaths = [];
    }

    if (typeof corrected.sessionTimeout !== 'number' || corrected.sessionTimeout < SESSION_TIMEOUT_MIN_MS) {
      corrected.sessionTimeout = SESSION_TIMEOUT_DEFAULT_MS;
    }

    return corrected;
  }
}

export class ConfigLoaderFactory extends Base {
  constructor(
    private readonly validator: IConfigValidator,
    private readonly fetcher: IConfigFetcher,
  ) {
    super();
  }

  createLoader(config: Config): ConfigLoader {
    if (config.id === 'demo') {
      return new DemoConfigLoader();
    }

    if (config.apiUrl) {
      return new CustomApiConfigLoader(this.validator, this.fetcher);
    }

    return new StandardConfigLoader(this.validator, this.fetcher);
  }
}
