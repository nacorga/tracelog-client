import {
  MAX_CUSTOM_EVENT_ARRAY_SIZE,
  MAX_CUSTOM_EVENT_KEYS,
  MAX_CUSTOM_EVENT_NAME_LENGTH,
  MAX_CUSTOM_EVENT_STRING_SIZE,
} from '../constants';
import { EventType, MetadataType, ScrollDirection, EventData, Queue, Config, ApiConfig } from '../types';
import { sanitizeMetadata } from './sanitize.utils';

export const isOnlyPrimitiveFields = (object: Record<string, any>): boolean => {
  if (typeof object !== 'object' || object === null) {
    return false;
  }

  for (const value of Object.values(object)) {
    if (value === null || value === undefined) {
      continue;
    }

    const type = typeof value;
    if (type === 'string' || type === 'number' || type === 'boolean') {
      continue;
    }

    if (Array.isArray(value)) {
      if (!value.every((item) => typeof item === 'string')) {
        return false;
      }

      continue;
    }

    return false;
  }

  return true;
};

export const isValidUrl = (url: string, allowedDomain: string, allowHttp = false): boolean => {
  try {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const isHttp = parsed.protocol === 'http:';
    const hostname = parsed.hostname;
    const isAllowedDomain = hostname === allowedDomain || hostname.endsWith('.' + allowedDomain);

    return (isHttps || (allowHttp && isHttp)) && isAllowedDomain;
  } catch {
    return false;
  }
};

export const isTracelogQueue = (value: unknown): value is Queue => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const queue = value as Record<string, unknown>;

  if (typeof queue.user_id !== 'string' || typeof queue.session_id !== 'string' || typeof queue.device !== 'string') {
    return false;
  }

  if (!Array.isArray(queue.events)) {
    return false;
  }

  if (!queue.events.every((event) => isTracelogEvent(event))) {
    return false;
  }

  if (queue.global_metadata !== undefined && typeof queue.global_metadata !== 'object') {
    return false;
  }

  return true;
};

export const isTracelogEvent = (value: unknown): value is EventData => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const event = value as Record<string, unknown>;

  if (!isEventType(event.type)) {
    return false;
  }

  if (typeof event.page_url !== 'string') {
    return false;
  }

  if (typeof event.timestamp !== 'number') {
    return false;
  }

  if (event.referrer !== undefined && typeof event.referrer !== 'string') {
    return false;
  }

  if (event.from_page_url !== undefined && typeof event.from_page_url !== 'string') {
    return false;
  }

  if (event.scroll_data !== undefined) {
    const scrollData = event.scroll_data as any;

    if (typeof scrollData.depth !== 'number' || !isScrollDirection(scrollData.direction)) {
      return false;
    }
  }

  if (event.click_data !== undefined) {
    const clickData = event.click_data as any;

    if (
      typeof clickData.x !== 'number' ||
      typeof clickData.y !== 'number' ||
      typeof clickData.relativeX !== 'number' ||
      typeof clickData.relativeY !== 'number'
    ) {
      return false;
    }
  }

  if (event.custom_event !== undefined) {
    const customEvent = event.custom_event as any;

    if (typeof customEvent.name !== 'string') {
      return false;
    }

    if (customEvent.metadata !== undefined && !isValidMetadataRecord(customEvent.metadata)) {
      return false;
    }
  }

  return true;
};

export const isMetadataType = (value: unknown): value is MetadataType => {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every((item) => typeof item === 'string');
  }

  return false;
};

export const isValidMetadataRecord = (value: unknown): value is Record<string, MetadataType> => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const object = value as Record<string, unknown>;
  return Object.values(object).every((value_) => isMetadataType(value_));
};

export const isEventType = (value: unknown): value is EventType => {
  return typeof value === 'string' && Object.values(EventType).includes(value as EventType);
};

export const isScrollDirection = (value: unknown): value is ScrollDirection => {
  return typeof value === 'string' && Object.values(ScrollDirection).includes(value as ScrollDirection);
};

export const isValidEventName = (eventName: string): { valid: boolean; error?: string } => {
  if (typeof eventName !== 'string') {
    return {
      valid: false,
      error: 'Event name must be a string',
    };
  }

  if (eventName.length === 0) {
    return {
      valid: false,
      error: 'Event name cannot be empty',
    };
  }

  if (eventName.length > MAX_CUSTOM_EVENT_NAME_LENGTH) {
    return {
      valid: false,
      error: `Event name is too long (max ${MAX_CUSTOM_EVENT_NAME_LENGTH} characters)`,
    };
  }

  if (eventName.includes('<') || eventName.includes('>') || eventName.includes('&')) {
    return {
      valid: false,
      error: 'Event name contains invalid characters',
    };
  }

  const reservedWords = ['constructor', 'prototype', '__proto__', 'eval', 'function', 'var', 'let', 'const'];

  if (reservedWords.includes(eventName.toLowerCase())) {
    return {
      valid: false,
      error: 'Event name cannot be a reserved word',
    };
  }

  return { valid: true };
};

export const isValidMetadata = (
  eventName: string,
  metadata: Record<string, any>,
  type?: 'globalMetadata' | 'customEvent',
): { valid: boolean; error?: string; sanitizedMetadata?: Record<string, any> } => {
  const sanitizedMetadata = sanitizeMetadata(metadata);
  const intro =
    type && type === 'customEvent' ? `${type} "${eventName}" metadata error` : `${eventName} metadata error`;

  if (!isOnlyPrimitiveFields(sanitizedMetadata)) {
    return {
      valid: false,
      error: `${intro}: object has invalid types. Valid types are string, number, boolean or string arrays.`,
    };
  }

  let jsonString: string;

  try {
    jsonString = JSON.stringify(sanitizedMetadata);
  } catch {
    return {
      valid: false,
      error: `${intro}: object contains circular references or cannot be serialized.`,
    };
  }

  if (jsonString.length > MAX_CUSTOM_EVENT_STRING_SIZE) {
    return {
      valid: false,
      error: `${intro}: object is too large (max ${MAX_CUSTOM_EVENT_STRING_SIZE / 1024} KB).`,
    };
  }

  const keyCount = Object.keys(sanitizedMetadata).length;

  if (keyCount > MAX_CUSTOM_EVENT_KEYS) {
    return {
      valid: false,
      error: `${intro}: object has too many keys (max ${MAX_CUSTOM_EVENT_KEYS} keys).`,
    };
  }

  for (const [key, value] of Object.entries(sanitizedMetadata)) {
    if (Array.isArray(value)) {
      if (value.length > MAX_CUSTOM_EVENT_ARRAY_SIZE) {
        return {
          valid: false,
          error: `${intro}: array property "${key}" is too large (max ${MAX_CUSTOM_EVENT_ARRAY_SIZE} items).`,
        };
      }

      for (const item of value) {
        if (typeof item === 'string' && item.length > 500) {
          return {
            valid: false,
            error: `${intro}: array property "${key}" contains strings that are too long (max 500 characters).`,
          };
        }
      }
    }

    if (typeof value === 'string' && value.length > 1000) {
      return {
        valid: false,
        error: `${intro}: property "${key}" is too long (max 1000 characters).`,
      };
    }
  }

  return {
    valid: true,
    sanitizedMetadata,
  };
};

export const isEventValid = (
  eventName: string,
  metadata?: Record<string, any>,
): { valid: boolean; error?: string; sanitizedMetadata?: Record<string, any> } => {
  const nameValidation = isValidEventName(eventName);

  if (!nameValidation.valid) {
    return nameValidation;
  }

  if (!metadata) {
    return { valid: true };
  }

  return isValidMetadata(eventName, metadata, 'customEvent');
};

const validateSamplingRate = (samplingRate: unknown, errors: string[]): void => {
  if (samplingRate !== undefined) {
    if (typeof samplingRate !== 'number') {
      errors.push('samplingRate must be a number');
    } else if (samplingRate < 0 || samplingRate > 1) {
      errors.push('samplingRate must be between 0 and 1');
    }
  }
};

const validateExcludedUrlPaths = (excludedUrlPaths: unknown, errors: string[], prefix = ''): void => {
  if (excludedUrlPaths !== undefined) {
    if (Array.isArray(excludedUrlPaths)) {
      for (const [index, path] of excludedUrlPaths.entries()) {
        if (typeof path === 'string') {
          try {
            new RegExp(path);
          } catch {
            errors.push(`${prefix}excludedUrlPaths[${index}] is not a valid regex pattern`);
          }
        } else {
          errors.push(`${prefix}excludedUrlPaths[${index}] must be a string`);
        }
      }
    } else {
      errors.push(`${prefix}excludedUrlPaths must be an array`);
    }
  }
};

export const validateConfig = (config: Config): { errors: string[]; warnings: string[] } => {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (config.sessionTimeout !== undefined) {
    if (typeof config.sessionTimeout !== 'number') {
      errors.push('sessionTimeout must be a number');
    } else if (config.sessionTimeout < 30_000) {
      errors.push('sessionTimeout must be at least 30 seconds (30000ms)');
    } else if (config.sessionTimeout > 24 * 60 * 60 * 1000) {
      warnings.push('sessionTimeout is very long (>24 hours), consider reducing it');
    }
  }

  if (config.globalMetadata !== undefined) {
    if (typeof config.globalMetadata !== 'object' || config.globalMetadata === null) {
      errors.push('globalMetadata must be an object');
    } else {
      const metadataSize = JSON.stringify(config.globalMetadata).length;

      if (metadataSize > 10_240) {
        errors.push('globalMetadata is too large (max 10KB)');
      }

      if (Object.keys(config.globalMetadata).length > 12) {
        errors.push('globalMetadata has too many keys (max 12)');
      }
    }
  }

  // No custom API endpoints supported

  validateSamplingRate(config.samplingRate, errors);

  if (config.qaMode !== undefined && typeof config.qaMode !== 'boolean') {
    errors.push('qaMode must be a boolean');
  }

  if (config.tags !== undefined && !Array.isArray(config.tags)) {
    errors.push('tags must be an array');
  }

  validateExcludedUrlPaths(config.excludedUrlPaths, errors);

  return { errors, warnings };
};

export const validateFinalConfig = (config: Config): { errors: string[]; warnings: string[] } => {
  const errors: string[] = [];
  const warnings: string[] = [];

  validateSamplingRate(config.samplingRate, errors);
  validateExcludedUrlPaths(config.excludedUrlPaths, errors);
  // No custom API endpoints supported

  return { errors, warnings };
};

export const isValidConfigApiResponse = (json: unknown): json is ApiConfig => {
  try {
    if (typeof json !== 'object' || !json) {
      return false;
    }

    const response = json as Record<string, unknown>;

    const result: Record<keyof ApiConfig, boolean> = {
      qaMode: response['qaMode'] === undefined || typeof response['qaMode'] === 'boolean',
      samplingRate:
        response['samplingRate'] === undefined ||
        (typeof response['samplingRate'] === 'number' && response['samplingRate'] > 0 && response['samplingRate'] <= 1),
      tags: response['tags'] === undefined || Array.isArray(response['tags']),
      excludedUrlPaths: response['excludedUrlPaths'] === undefined || Array.isArray(response['excludedUrlPaths']),
    };

    return Object.values(result).every(Boolean);
  } catch {
    return false;
  }
};
