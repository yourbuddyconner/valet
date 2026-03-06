import { describe, it, expect } from 'vitest';
import { telegramProvider } from './provider.js';

describe('telegramProvider', () => {
  it('has correct service name', () => {
    expect(telegramProvider.service).toBe('telegram');
  });

  it('has correct display name', () => {
    expect(telegramProvider.displayName).toBe('Telegram');
  });

  it('uses bot_token auth type', () => {
    expect(telegramProvider.authType).toBe('bot_token');
  });
});
