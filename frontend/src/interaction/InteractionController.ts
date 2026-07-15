export type NavigationDirection = 'previous' | 'next';
export type InteractionState = 'idle' | 'tracking' | 'swiping';

export const SWIPE_CONFIG = {
  intentDistance: 10,
  minDistance: 56,
  minVelocity: 0.45,
  horizontalRatio: 1.3,
} as const;

export interface InteractionPoint {
  x: number;
  y: number;
  time: number;
}

export interface InteractionControllerOptions {
  navigate: (direction: NavigationDirection) => void | Promise<unknown>;
  tap?: () => void;
  enabled?: () => boolean;
}

export class InteractionController {
  private state: InteractionState = 'idle';
  private startPoint: InteractionPoint | null = null;
  private moved = false;

  constructor(private readonly options: InteractionControllerOptions) {}

  getState(): InteractionState {
    return this.state;
  }

  start(point: InteractionPoint): void {
    if (this.options.enabled?.() === false) {
      this.reset();
      return;
    }
    this.state = 'tracking';
    this.startPoint = point;
    this.moved = false;
  }

  move(point: InteractionPoint): void {
    if (!this.startPoint || this.state === 'idle') return;
    const dx = point.x - this.startPoint.x;
    const dy = point.y - this.startPoint.y;
    if (Math.hypot(dx, dy) >= SWIPE_CONFIG.intentDistance) this.moved = true;
    if (Math.abs(dx) >= SWIPE_CONFIG.intentDistance && Math.abs(dx) > Math.abs(dy) * SWIPE_CONFIG.horizontalRatio) {
      this.state = 'swiping';
    }
  }

  end(point: InteractionPoint): void {
    if (!this.startPoint || this.state === 'idle') return;
    const start = this.startPoint;
    const wasMoved = this.moved;
    const dx = point.x - start.x;
    const dy = point.y - start.y;
    const duration = Math.max(1, point.time - start.time);
    const velocity = Math.abs(dx) / duration;
    const isHorizontal = Math.abs(dx) > Math.abs(dy) * SWIPE_CONFIG.horizontalRatio;
    const isSwipe = isHorizontal && (Math.abs(dx) >= SWIPE_CONFIG.minDistance || velocity >= SWIPE_CONFIG.minVelocity);
    this.reset();

    if (this.options.enabled?.() === false) return;
    if (isSwipe) {
      void this.options.navigate(dx < 0 ? 'next' : 'previous');
    } else if (!wasMoved) {
      this.options.tap?.();
    }
  }

  cancel(): void {
    this.reset();
  }

  private reset(): void {
    this.state = 'idle';
    this.startPoint = null;
    this.moved = false;
  }
}
