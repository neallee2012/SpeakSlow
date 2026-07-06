import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';

// The real ../i18n pulls in opencc-js + electronAPI-driven effects; mock it so the
// hooks under test get a deterministic t() without browser/IPC dependencies.
vi.mock('../i18n', () => ({
  useTranslation: () => ({
    t: (key, params) =>
      params && params.error !== undefined ? `${key}:${params.error}` : key,
  }),
  convertText: (text) => text,
}));

import { useModelStatus } from './useModelStatus';

describe('useModelStatus — Azure gate logic', () => {
  afterEach(() => {
    cleanup(); // unmount hooks so the 3s polling interval + focus listener are torn down
    delete window.electronAPI;
    vi.restoreAllMocks();
  });

  describe('azure provider short-circuit', () => {
    let getSetting;
    let checkModelFiles;
    let checkSherpaStatus;

    beforeEach(() => {
      getSetting = vi.fn(async (key) =>
        key === 'asr_provider' ? 'azure' : undefined
      );
      checkModelFiles = vi.fn(async () => ({
        success: true,
        models_downloaded: true,
        server_ready: true,
        models_initialized: true,
      }));
      checkSherpaStatus = vi.fn(async () => ({ success: true }));
      window.electronAPI = {
        getSetting,
        checkModelFiles,
        checkSherpaStatus,
        downloadModels: vi.fn(async () => ({ success: true })),
        restartSherpaServer: vi.fn(async () => ({ success: true })),
        getDownloadProgress: vi.fn(async () => ({ success: false })),
        onModelDownloadProgress: vi.fn(() => () => {}),
        onProcessingUpdate: vi.fn(() => () => {}),
        log: vi.fn(),
      };
    });

    it('reports ready immediately without touching local model checks', async () => {
      const { result } = renderHook(() => useModelStatus());

      await waitFor(() => {
        expect(result.current.isReady).toBe(true);
      });

      expect(result.current.stage).toBe('ready');
      expect(result.current.isLoading).toBe(false);
      expect(result.current.isDownloading).toBe(false);
      expect(result.current.modelsDownloaded).toBe(true);
      expect(result.current.missingModels).toEqual([]);
      expect(result.current.error).toBeNull();
      expect(result.current.progress).toBe(100);

      // Azure path must short-circuit before any local model / sherpa probing.
      expect(getSetting).toHaveBeenCalledWith('asr_provider');
      expect(checkModelFiles).not.toHaveBeenCalled();
      expect(checkSherpaStatus).not.toHaveBeenCalled();
    });
  });

  describe('local provider path', () => {
    let getSetting;
    let checkModelFiles;
    let checkSherpaStatus;

    beforeEach(() => {
      getSetting = vi.fn(async (key) =>
        key === 'asr_provider' ? 'local' : undefined
      );
      checkModelFiles = vi.fn(async () => ({
        success: true,
        models_downloaded: false,
        missing_models: ['x'],
      }));
      checkSherpaStatus = vi.fn(async () => ({ success: false }));
      window.electronAPI = {
        getSetting,
        checkModelFiles,
        checkSherpaStatus,
        downloadModels: vi.fn(async () => ({ success: true })),
        restartSherpaServer: vi.fn(async () => ({ success: true })),
        getDownloadProgress: vi.fn(async () => ({ success: false })),
        onModelDownloadProgress: vi.fn(() => () => {}),
        onProcessingUpdate: vi.fn(() => () => {}),
        log: vi.fn(),
      };
    });

    it('checks model files and reports need_download when models are missing', async () => {
      const { result } = renderHook(() => useModelStatus());

      await waitFor(() => {
        expect(result.current.stage).toBe('need_download');
      });

      expect(checkModelFiles).toHaveBeenCalled();
      expect(result.current.isReady).toBe(false);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.modelsDownloaded).toBe(false);
      expect(result.current.missingModels).toEqual(['x']);
      expect(result.current.error).toBeNull();
      expect(result.current.progress).toBe(0);
      // Not downloading yet — the hook only flags need_download; download is user-triggered.
      expect(result.current.isDownloading).toBe(false);
    });
  });
});
