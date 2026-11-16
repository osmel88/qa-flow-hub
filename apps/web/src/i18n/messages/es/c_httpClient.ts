import type { c_httpClient as source } from '../en/c_httpClient';

export const c_httpClient: Partial<Record<keyof typeof source, string>> = {
  'c_httpClient.requestFailed': 'La petición falló con el estado {status}',
};
