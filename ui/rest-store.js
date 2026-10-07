import { normalizeConfig } from './rest-model.js';

const NAMESPACE = 'civ7-rest-guard';
const SHARED_KEY = 'modSettings';

export class RestStore {
  constructor(storage, warn = console.warn) {
    this.storage = storage;
    this.warn = warn;
    this.error = false;
    this.data = { version: 3, config: normalizeConfig() };
    try {
      const saved = JSON.parse(storage.getItem(SHARED_KEY) || '{}')[NAMESPACE];
      if (saved && typeof saved === 'object') {
        this.data.config = normalizeConfig(saved.config);
        // One-time migration removes the old mod's turn, age and timer records.
        if (saved.version !== 3 || 'campaigns' in saved) this.save();
      }
    } catch (error) { this.report(error); }
  }

  save() {
    try {
      const shared = JSON.parse(this.storage.getItem(SHARED_KEY) || '{}');
      if (!shared || typeof shared !== 'object' || Array.isArray(shared)) throw new Error('Invalid shared settings');
      // Whitelist settings only; runtime state must never be persisted.
      shared[NAMESPACE] = { version: 3, config: normalizeConfig(this.data.config) };
      this.storage.setItem(SHARED_KEY, JSON.stringify(shared));
      this.error = false;
      return true;
    } catch (error) {
      this.report(error);
      return false;
    }
  }

  report(error) {
    this.error = true;
    this.warn(`[Rest Guard] Settings persistence unavailable: ${error}`);
  }
}
