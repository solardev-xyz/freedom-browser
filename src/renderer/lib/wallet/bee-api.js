/**
 * Shared Bee API fetch helper.
 */

import { buildBeeUrl } from '../state.js';

export async function fetchBeeJson(endpoint) {
  const response = await fetch(buildBeeUrl(endpoint));
  const text = await response.text();

  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  return { ok: response.ok, status: response.status, data };
}
