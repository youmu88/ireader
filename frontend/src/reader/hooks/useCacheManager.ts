/**
 * useCacheManager — 客户端离线缓存管理 hook（从 ReaderPage 提取）
 *
 * 职责：管理书籍章节/语音的 IndexedDB 缓存状态与操作。
 */
import { useState, useCallback } from 'react';
import axios from 'axios';
import {
  cacheBookChapters,
  cacheSingleChapter,
  getCachedChapterContent,
  getCachedTTSAudio,
  cacheTTSAudio,
  getBookCacheDetailedStats,
  clearBookChapterCache,
  clearBookTTSAudioCache,
  downloadBatchCachedAudio,
  downloadOfflineEpubPackage,
} from '../../services/offlineCacheService';
import type { BookCacheDetailedStats } from '../../services/offlineCacheService';
import { getDefaultPlayer, splitText } from '../../services/ttsPlayer';
import { getToken } from '../../services/authService';
import { stripHtml } from '../utils/stripHtml';
import type { Chapter } from '../types';

interface BookLike {
  id: string;
  title: string;
  format: 'epub' | 'txt';
}

export interface UseCacheManagerParams {
  bookId: string | undefined;
  book: BookLike | null;
  chapters: Chapter[];
  currentChapter: Chapter | null;
  ttsVoice: string;
  ttsSpeed: number;
}

export interface UseCacheManagerReturn {
  cacheStatus: BookCacheDetailedStats | null;
  cachingInProgress: boolean;
  cacheProgressText: string;
  checkCacheStatus: () => Promise<void>;
  handleCacheCurrentChapter: () => Promise<void>;
  handleCacheFullBook: () => Promise<void>;
  handleClearTextCache: () => Promise<void>;
  handleClearAudioCache: () => Promise<void>;
}

export function useCacheManager({ bookId, book, chapters, currentChapter, ttsVoice, ttsSpeed }: UseCacheManagerParams): UseCacheManagerReturn {
  const [cacheStatus, setCacheStatus] = useState<BookCacheDetailedStats | null>(null);
  const [cachingInProgress, setCachingInProgress] = useState(false);
  const [cacheProgressText, setCacheProgressText] = useState('');

  const checkCacheStatus = useCallback(async () => {
    if (!bookId) return;
    try {
      setCacheStatus(await getBookCacheDetailedStats(bookId));
    } catch {
      setCacheStatus(null);
    }
  }, [bookId]);

  const handleCacheCurrentChapter = useCallback(async () => {
    if (!bookId || !currentChapter || !book) return;
    setCachingInProgress(true);
    try {
      const res = await axios.get(`/api/books/${bookId}/chapters/${currentChapter.id}/content`);
      const rawContent = res.data.data?.content || '';
      const content = book.format === 'epub' ? stripHtml(rawContent) : rawContent;
      await cacheSingleChapter(bookId, book.title, { chapterId: currentChapter.id, title: currentChapter.title, order: currentChapter.order, content });
      await checkCacheStatus();
    } catch (err) {
      console.warn('缓存章节失败:', err);
    } finally {
      setCachingInProgress(false);
    }
  }, [bookId, currentChapter, book, checkCacheStatus]);

  const handleCacheFullBook = useCallback(async () => {
    if (!bookId || !book || !chapters.length) return;
    const currentStats = cacheStatus ?? await getBookCacheDetailedStats(bookId);
    const textAlreadyCached = currentStats && chapters.length > 0 && currentStats.chapterCount >= chapters.length;
    if (textAlreadyCached && currentStats!.audioChapterCount >= chapters.length) return;

    setCachingInProgress(true);
    setCacheProgressText(textAlreadyCached ? '合成语音 0/' + chapters.length + ' 章' : '');
    try {
      let chapterData: { chapterId: string; title: string; order: number; content: string }[] = [];
      if (textAlreadyCached) {
        chapterData = (await Promise.all(chapters.map(async ch => {
          const content = await getCachedChapterContent(bookId, ch.id);
          return content ? { chapterId: ch.id, title: ch.title, order: ch.order, content } : null;
        }))).filter((item): item is { chapterId: string; title: string; order: number; content: string } => item !== null);
      } else {
        const totalCh = chapters.length;
        for (let ci = 0; ci < totalCh; ci++) {
          const ch = chapters[ci];
          setCacheProgressText(`获取章节 ${ci + 1}/${totalCh}`);
          const res = await axios.get(`/api/books/${bookId}/chapters/${ch.id}/content`);
          const rawContent = res.data.data?.content || '';
          const content = book.format === 'epub' ? stripHtml(rawContent) : rawContent;
          chapterData.push({ chapterId: ch.id, title: ch.title, order: ch.order, content });
        }
        await cacheBookChapters(bookId, book.title, chapterData);
      }

      if (book.format === 'epub') {
        setCacheProgressText('下载 EPUB 离线资源');
        await downloadOfflineEpubPackage(bookId, book.title, chapterData, (completed, total) => setCacheProgressText(`下载 EPUB 资源 ${completed}/${total}`));
      }

      // 语音合成缓存
      const player = getDefaultPlayer();
      const effectiveVoice = (() => { try { return localStorage.getItem('ireader_tts_voice') || player.getVoice() || ttsVoice; } catch { return ttsVoice; } })();
      const effectiveSpeed = (() => { try { const raw = localStorage.getItem('ireader_tts_synthesisRate') || localStorage.getItem('ireader_tts_speed'); return raw ? parseFloat(raw) : ttsSpeed; } catch { return ttsSpeed; } })();
      const noCachePref = (() => { try { return localStorage.getItem('ireader_tts_noCache') === 'true'; } catch { return false; } })();

      if (!noCachePref) {
        const MAX_CONCURRENT = 6;
        let totalCached = 0;
        const chapterSegments = new Map<string, string[]>();
        for (const ch of chapters) {
          const chData = chapterData.find(d => d.chapterId === ch.id);
          if (chData?.content) chapterSegments.set(ch.id, splitText(chData.content));
        }
        const effectiveSource = localStorage.getItem('ireader_tts_source') || player.getSource();
        let chapterMarkedDoneForBatch: Set<string> | undefined;
        const batchDownloaded = await downloadBatchCachedAudio(
          bookId, effectiveVoice, effectiveSpeed, effectiveSource, chapterSegments,
          () => { if (!chapterMarkedDoneForBatch) chapterMarkedDoneForBatch = new Set(); },
        );
        if (batchDownloaded > 0) console.log(`批量拉取预合成语音完成：${batchDownloaded} 段`);

        interface CacheTask { chapter: Chapter; seg: string; segIdx: number; }
        const allTasks: CacheTask[] = [];
        const chapterTotalSegments = new Map<string, number>();
        const chapterCompletedSegments = new Map<string, number>();
        for (const ch of chapters) {
          const chData = chapterData.find(d => d.chapterId === ch.id);
          if (!chData || !chData.content) continue;
          const segments = splitText(chData.content);
          chapterTotalSegments.set(ch.id, segments.length);
          chapterCompletedSegments.set(ch.id, 0);
          segments.forEach((seg, segIdx) => allTasks.push({ chapter: ch, seg, segIdx }));
        }
        const totalSegments = allTasks.length;
        const totalChapterCount = chapterTotalSegments.size;
        let completedChapterCount = 0;
        if (totalSegments > 0) {
          setCacheProgressText(`合成语音 0/${totalChapterCount} 章`);
          let i = 0;
          const chapterMarkedDone = new Set<string>();
          const next = async () => {
            while (i < allTasks.length) {
              const idx = i++;
              const task = allTasks[idx];
              try {
                const identity = { voice: effectiveVoice, synthesisRate: effectiveSpeed, source: effectiveSource, text: task.seg };
                const existing = await getCachedTTSAudio(bookId, task.chapter.id, task.segIdx, identity);
                if (!existing) {
                  const res = await fetch('/api/tts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) },
                    body: JSON.stringify({ input: task.seg, voice: effectiveVoice, speed: effectiveSpeed, response_format: 'wav', tts_source: effectiveSource, no_cache: false, book_id: bookId }),
                  });
                  if (res.ok) {
                    await cacheTTSAudio(bookId, task.chapter.id, task.segIdx, await res.arrayBuffer(), undefined, identity);
                    totalCached++;
                  }
                }
                const chDone = (chapterCompletedSegments.get(task.chapter.id) || 0) + 1;
                chapterCompletedSegments.set(task.chapter.id, chDone);
                if (chDone >= (chapterTotalSegments.get(task.chapter.id) || 0) && !chapterMarkedDone.has(task.chapter.id)) {
                  chapterMarkedDone.add(task.chapter.id);
                  completedChapterCount++;
                }
                setCacheProgressText(`合成语音 ${completedChapterCount}/${totalChapterCount} 章`);
              } catch { /* 单段失败不影响全书 */ }
            }
          };
          await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT, totalSegments) }, () => next()));
          console.log(`全书缓存完成：共拉取 ${batchDownloaded} 段预合成 + 新合成 ${totalCached} 段语音（${completedChapterCount}章）`);
        }
      }
      await checkCacheStatus();
      setCacheProgressText('');
    } catch (err) {
      console.warn('缓存全书失败:', err);
      setCacheProgressText('缓存失败');
    } finally {
      setCachingInProgress(false);
    }
  }, [bookId, book, chapters, cacheStatus, checkCacheStatus, ttsSpeed, ttsVoice]);

  const handleClearTextCache = useCallback(async () => {
    if (!bookId) return;
    try { await clearBookChapterCache(bookId); await checkCacheStatus(); } catch (err) { console.warn('清除文字缓存失败:', err); }
  }, [bookId, checkCacheStatus]);

  const handleClearAudioCache = useCallback(async () => {
    if (!bookId) return;
    try { await clearBookTTSAudioCache(bookId); await checkCacheStatus(); } catch (err) { console.warn('清除语音缓存失败:', err); }
  }, [bookId, checkCacheStatus]);

  return { cacheStatus, cachingInProgress, cacheProgressText, checkCacheStatus, handleCacheCurrentChapter, handleCacheFullBook, handleClearTextCache, handleClearAudioCache };
}
