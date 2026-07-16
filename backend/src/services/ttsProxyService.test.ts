/**
 * OpenAI-Compatible TTS Proxy Service 单元测试
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
    it('should return OpenAI-compatible source', () => {
      const sources = mod.getSources();
      expect(Array.isArray(sources)).toBe(true);
      expect(sources.length).toBe(1);
      expect(sources[0]).toHaveProperty('id');
      expect(sources[0]).toHaveProperty('name');
      expect(sources[0]).toHaveProperty('description');
    });

    it('should include openai source', () => {
      const sources = mod.getSources();
      const openai = sources.find((s: any) => s.id === 'openai');
      expect(openai).toBeDefined();
      expect(openai?.name).toContain('OpenAI');
    });
  });

  describe('checkHealth', () => {
    it('should return success when TTS service is available via /v1/models', async () => {
      const mockResponse = {
        ok: true,
        json: () => Promise.resolve({
          data: [
            { id: 'tts-1', owned_by: 'openai' },
            { id: 'tts-1-hd', owned_by: 'openai' },
          ],
        }),
      };
      mockFetch.mockResolvedValue(mockResponse);

      const result = await mod.checkHealth('http://127.0.0.1:8883', 'test-key');
      expect(result.success).toBe(true);
      expect(result.status).toBe('ok');
      expect(result.service).toBe('openai-compatible');
      expect(result.models).toHaveLength(2);
      expect(result.models?.[0].id).toBe('tts-1');
    });

    it('should fallback to /health when /v1/models fails', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 404 })  // /v1/models fails
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ status: 'ok', service: 'edge-tts' }),
        });  // /health succeeds

      const result = await mod.checkHealth('http://127.0.0.1:8883');
      expect(result.success).toBe(true);
      expect(result.service).toBe('edge-tts');
    });

    it('should return failure when TTS service is unavailable', async () => {
      mockFetch.mockRejectedValue(new Error('Connection refused'));

      const result = await mod.checkHealth('http://127.0.0.1:8883');
      expect(result.success).toBe(false);
      expect(result.error).toBe('TTS service unavailable');
    });
  });

  describe('getModels', () => {
    it('should return models from /v1/models', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          data: [
            { id: 'tts-1', owned_by: 'openai' },
            { id: 'tts-1-hd', owned_by: 'openai' },
          ],
        }),
      });

      const result = await mod.getModels('http://127.0.0.1:8883', 'test-key');
      expect(result.success).toBe(true);
      expect(result.data?.models).toHaveLength(2);
      expect(result.data?.models[0].id).toBe('tts-1');
    });

    it('should handle string array models format', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          models: ['tts-1', 'tts-1-hd'],
        }),
      });

      const result = await mod.getModels('http://127.0.0.1:8883');
      expect(result.success).toBe(true);
      expect(result.data?.models).toHaveLength(2);
      expect(result.data?.models[0].id).toBe('tts-1');
    });

    it('should return failure when models service is unavailable', async () => {
      mockFetch.mockRejectedValue(new Error('Connection refused'));

      const result = await mod.getModels('http://127.0.0.1:8883');
      expect(result.success).toBe(false);
      expect(result.error).toBe('TTS service unavailable');
    });
  });

  describe('getVoices', () => {
    it('should normalize standard voices format', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          voices: [
            { id: 'alloy', name: 'Alloy' },
            { id: 'echo', name: 'Echo' },
          ],
        }),
      });

      const result = await mod.getVoices('http://127.0.0.1:8883', 'test-key');
      expect(result.success).toBe(true);
      expect(result.data?.voices).toHaveLength(2);
      expect(result.data?.voices[0]).toEqual({ id: 'alloy', name: 'Alloy' });
    });

    it('should normalize string array voices format', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          voices: ['alloy', 'echo', 'fable'],
        }),
      });

      const result = await mod.getVoices('http://127.0.0.1:8883');
      expect(result.success).toBe(true);
      expect(result.data?.voices).toHaveLength(3);
      expect(result.data?.voices[0]).toEqual({ id: 'alloy', name: 'alloy' });
    });

    it('should normalize Kokoro-style format (chinese/english arrays)', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          chinese: ['zf_xiaobei', 'zf_xiaoni'],
          english: ['af_heart'],
        }),
      });

      const result = await mod.getVoices('http://127.0.0.1:8883');
      expect(result.success).toBe(true);
      expect(result.data?.voices).toHaveLength(3);
      expect(result.data?.voices[0]).toEqual({ id: 'zf_xiaobei', name: 'zf_xiaobei' });
    });

    it('should return failure when voices service is unavailable', async () => {
      mockFetch.mockRejectedValue(new Error('Connection refused'));

      const result = await mod.getVoices('http://127.0.0.1:8883');
      expect(result.success).toBe(false);
      expect(result.error).toBe('TTS service unavailable');
    });

    it('should handle empty voice data', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });

      const result = await mod.getVoices('http://127.0.0.1:8883');
      expect(result.success).toBe(true);
      expect(result.data?.voices).toEqual([]);
    });
  });

  describe('synthesize', () => {
    it('should require input text', async () => {
      const result = await mod.synthesize({ input: '', apiUrl: 'http://127.0.0.1:8883' });
      expect(result.success).toBe(false);
      expect(result.status).toBe(400);
      expect(result.error).toBe('input is required');
    });

    it('should reject whitespace-only input', async () => {
      const result = await mod.synthesize({ input: '   ', apiUrl: 'http://127.0.0.1:8883' });
      expect(result.success).toBe(false);
      expect(result.status).toBe(400);
    });

    it('should require apiUrl', async () => {
      const result = await mod.synthesize({ input: 'hello', apiUrl: '' });
      expect(result.success).toBe(false);
      expect(result.status).toBe(400);
      expect(result.error).toBe('apiUrl is required');
    });

    it('should return audio on successful synthesis', async () => {
      const mockAudioData = new ArrayBuffer(1024);
      mockFetch.mockResolvedValue({
        ok: true,
        headers: new Map([['content-type', 'audio/wav']]),
        arrayBuffer: () => Promise.resolve(mockAudioData),
      });

      const result = await mod.synthesize({ input: '你好世界', apiUrl: 'http://127.0.0.1:8883' });
      expect(result.success).toBe(true);
      expect(result.audio).toBeDefined();
      expect(result.audio?.length).toBe(1024);
      expect(result.contentType).toBe('audio/wav');
    });

    it('should pass model in request body', async () => {
      const mockAudioData = new ArrayBuffer(512);
      mockFetch.mockResolvedValue({
        ok: true,
        headers: new Map([['content-type', 'audio/wav']]),
        arrayBuffer: () => Promise.resolve(mockAudioData),
      });

      await mod.synthesize({ input: 'test', model: 'tts-1-hd', apiUrl: 'http://127.0.0.1:8883' });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://127.0.0.1:8883/v1/audio/speech',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"model":"tts-1-hd"'),
        }),
      );
    });

    it('should handle TTS backend errors', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal server error'),
      });

      const result = await mod.synthesize({ input: 'hello', apiUrl: 'http://127.0.0.1:8883' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('TTS failed');
    });

    it('should handle network errors', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const result = await mod.synthesize({ input: 'hello', apiUrl: 'http://127.0.0.1:8883' });
      expect(result.success).toBe(false);
      expect(result.status).toBe(502);
      expect(result.error).toBe('TTS service unavailable');
    });
  });
});
