import { MetadataType } from './common.types';
import { TagConfig } from './tag.types';

export type Config = ApiConfig & AppConfig;

export interface ApiConfig {
  /**
   * Enables QA mode for testing and debugging purposes.
   * When enabled, events may be processed differently for development environments.
   */
  qaMode?: boolean;
  /**
   * Sampling rate as a percentage (0-1) to control how many events are sent.
   * A value of 1 means all events are sent, while 0.5 means only half of events are sent.
   */
  samplingRate?: number;
  /**
   * Array of tag configurations for categorizing and filtering events.
   * Tags help organize and segment tracking data for analysis.
   */
  tags?: TagConfig[];
  /**
   * Array of URL path patterns to exclude from tracking.
   * Events will not be sent for pages matching these patterns.
   */
  excludedUrlPaths?: string[];
}

export interface AppConfig {
  /**
   * Unique project identifier.
   */
  id: string;
  /**
   * Session timeout in minutes. After this period of inactivity,
   * a new session will be started for subsequent events.
   * @default 30
   */
  sessionTimeout?: number;
  /**
   * Metadata that will be automatically attached to all tracking events.
   * These key-value pairs provide additional context for every event sent.
   */
  globalMetadata?: Record<string, MetadataType>;
  /**
   * CSS selectors for custom scroll containers. Can be a single selector string
   * or an array of selectors. Used to track scroll events within specific elements
   * instead of the default window scroll.
   */
  scrollContainerSelectors?: string | string[];
  /**
   * Allow HTTP requests to be made. This is useful for testing and development.
   */
  allowHttp?: boolean;
  /**
   * Array of query parameters to be removed from the URL.
   */
  sensitiveQueryParams?: string[];
}
