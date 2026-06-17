import { StorageService } from './StorageService';

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

export const ClientService = {
  async getOrCreateClientId() {
    let id = await StorageService.getClientId();
    if (!id) {
      id = generateUUID();
      await StorageService.saveClientId(id);
    }
    return id;
  },

  formatForDisplay(clientId) {
    if (!clientId) return '----';
    const short = clientId.replace(/-/g, '').toUpperCase().slice(0, 8);
    return `ARIA-${short.slice(0, 4)}-${short.slice(4, 8)}`;
  },
};