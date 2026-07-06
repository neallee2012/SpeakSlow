import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// Mock ../i18n (pulls in opencc-js + electronAPI effects). t() echoes the key,
// appending params.error so error-propagation can be asserted.
vi.mock('../i18n', () => ({
  useTranslation: () => ({
    t: (key, params) =>
      params && params.error !== undefined ? `${key}:${params.error}` : key,
  }),
  convertText: (text) => text,
}));

import { useRecording } from './useRecording';

const stubElectronAPI = () => {
  window.electronAPI = {
    getSetting: vi.fn(async (key, defaultValue) => defaultValue),
    log: vi.fn(),
    transcribeAudio: vi.fn(async () => ({ success: true, text: '' })),
    recoveryBegin: vi.fn(),
    recoveryAppend: vi.fn(),
    recoveryEnd: vi.fn(),
    precogStart: vi.fn(async () => ({ success: false })),
    precogFeed: vi.fn(),
    precogAbort: vi.fn(),
    applyDictionary: vi.fn(async (text) => text),
    saveTranscription: vi.fn(async () => ({ success: true })),
    processText: vi.fn(async () => ({ success: false })),
  };
};

const setMediaDevices = (mediaDevices) => {
  Object.defineProperty(window.navigator, 'mediaDevices', {
    value: mediaDevices,
    configurable: true,
    writable: true,
  });
};

describe('useRecording — Azure gate at startRecording', () => {
  beforeEach(() => {
    stubElectronAPI();
  });

  afterEach(() => {
    cleanup();
    delete window.electronAPI;
    setMediaDevices(undefined);
    vi.restoreAllMocks();
  });

  it('local provider + model not ready: throws before touching getUserMedia', async () => {
    const getUserMedia = vi.fn();
    setMediaDevices({ getUserMedia });

    const { result } = renderHook(() =>
      useRecording({ isReady: false, isLoading: false, error: null }, 'local')
    );

    await act(async () => {
      await result.current.startRecording();
    });

    // Gate throws errors.asrPreparing (not loading, no prior error), which is
    // wrapped into errors.cannotStartRecording by the catch block.
    expect(result.current.error).toBeTruthy();
    expect(result.current.error).toBe(
      'errors.cannotStartRecording:errors.asrPreparing'
    );
    expect(result.current.isRecording).toBe(false);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('azure provider + model not ready: gate bypassed, getUserMedia is reached', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new Error('denied'));
    setMediaDevices({ getUserMedia });

    const { result } = renderHook(() =>
      useRecording({ isReady: false, isLoading: false, error: null }, 'azure')
    );

    await act(async () => {
      await result.current.startRecording();
    });

    // Azure bypasses the local-model readiness gate entirely...
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    // ...so the only failure is the (mocked) mic permission rejection.
    expect(result.current.error).toBe(
      'errors.cannotStartRecording:denied'
    );
    expect(result.current.isRecording).toBe(false);
  });
});
