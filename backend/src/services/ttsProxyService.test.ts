/**
 * TTS Proxy Service 单元测试
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

// Mock global fetch before importing the module
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Load after mock
const mod = await import('../services/ttsProxyService.js');

describe('ttsProxyService', () => {
  beforeAll(() => {
    vi.clearAllMocks();
  });

  describe('getSources', () => {
    it('should return available TTS sources', () => {
      const sources = mod.getSources();
      expect(Array.isArray(sources)).toBe(true);
      expect(sources.length).toBeGreaterThanOrEqual(2);
      expect(sources[0]).toHaveProperty('id');
      expect(sources[0]).toHaveProperty('name');
      expect(sources[0]).toHaveProperty('description');
    });

    it('should include kokoro source', () => {
      const sources = mod.getSources();
      const kokoro = sources.find((s: any) => s.id === 'kokoro');
      expect(kokoro).toBeDefined();
      expect(kokoro?.name).toContain('Kokoro');
    });

    it('should include megatts3 source', () => {
      const sources = mod.getSources();
      const megatts3 = sources.find((s: any) => s.id === 'megatts3');
      expect(megatts3).toBeDefined();
      expect(megatts3?.name).toContain('MegaTTS3');
    });
  });

  describe('checkHealth', () => {
    it('should return success when TTS service is available', async () => {
      const mockResponse = {
        ok: true,
        json: () => Promise.resolve({ status: 'ok', service: 'kokoro-tts', memory_mb: 512.3 }),
      };
      mockFetch.mockResolvedValue(mockResponse);

      const result = await mod.checkHealth('kokoro');
      expect(result.success).toBe(true);
      expect(result.status).toBe('ok');
      expect(result.service).toBe('kokoro-tts');
      expect(result.memory_mb).toBe(512.3);
    });

    it('should return failure when TTS service is unavailable', async () => {
      mockFetch.mockRejectedValue(new Error('Connection refused'));

      const result = await mod.checkHealth('kokoro');
      expect(result.success).toBe(false);
      expect(result.error).toBe('TTS service unavailable');
    });

    it('should use correct URL for megatts3 source', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: 'ok', service: 'megatts3' }),
      });

      await mod.checkHealth('megatts3');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('8882'),
        expect.any(Object)
      );
    });
  });

  describe('getVoices', () => {
    it('should normalize Kokoro voices format', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          chinese: ['zf_xiaobei', 'zf_xiaoni'],
          english: ['af_heart'],
        }),
      });

      const result = await mod.getVoices('kokoro');
      expect(result.success).toBe(true);
      expect(result.data?.voices).toHaveLength(3);
      expect(result.data?.voices[0]).toEqual({ id: 'zf_xiaobei', name: '小北' });
      expect(result.data?.voices[1]).toEqual({ id: 'zf_xiaoni', name: '小妮' });
    });

    it('should pass through MegaTTS3 voices format', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          voices: [{ id: 'voice1', name: 'Voice 1' }],
        }),
      });

      const result = await mod.getVoices('megatts3');
      expect(result.success).toBe(true);
      expect(result.data?.voices).toHaveLength(1);
      expect(result.data?.voices[0]).toEqual({ id: 'voice1', name: 'Voice 1' });
    });

    it('should return failure when voices service is unavailable', async () => {
      mockFetch.mockRejectedValue(new Error('Connection refused'));

      const result = await mod.getVoices('kokoro');
      expect(result.success).toBe(false);
      expect(result.error).toBe('TTS service unavailable');
    });

    it('should handle empty voice data', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });

      const result = await mod.getVoices('kokoro');
      expect(result.success).toBe(true);
      expect(result.data?.voices).toEqual([]);
    });
  });

  describe('synthesize', () => {
    it('should require input text', async () => {
      const result = await mod.synthesize({ input: '' });
      expect(result.success).toBe(false);
      expect(result.status).toBe(400);
      expect(result.error).toBe('input is required');
    });

    it('should reject whitespace-only input', async () => {
      const result = await mod.synthesize({ input: '   ' });
      expect(result.success).toBe(false);
      expect(result.status).toBe(400);
    });

    it('should return audio on successful synthesis', async () => {
      const mockAudioData = new ArrayBuffer(1024);
      mockFetch.mockResolvedValue({
        ok: true,
        headers: new Map([['content-type', 'audio/wav']]),
        arrayBuffer: () => Promise.resolve(mockAudioData),
      });

      const result = await mod.synthesize({ input: '你好世界' });
      expect(result.success).toBe(true);
      expect(result.audio).toBeDefined();
      expect(result.audio?.length).toBe(1024);
      expect(result.contentType).toBe('audio/wav');
    });

    it('should handle TTS backend errors', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal server error'),
      });

      const result = await mod.synthesize({ input: 'hello' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('TTS failed');
    });

    it('should handle network errors', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const result = await mod.synthesize({ input: 'hello' });
      expect(result.success).toBe(false);
      expect(result.status).toBe(502);
      expect(result.error).toBe('TTS service unavailable');
    });
  });
});
