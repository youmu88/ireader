import { InteractionController, type InteractionPoint } from './InteractionController';

export type InputTarget = HTMLElement | Document;

function point(x: number, y: number, timeStamp: number): InteractionPoint {
  return { x, y, time: timeStamp || performance.now() };
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('button, a, input, textarea, select, [contenteditable="true"], [data-gesture-ignore]'));
}

export class InputSurface {
  private abortController: AbortController | null = null;
  private ignoreMouseUntil = 0;

  constructor(
    private readonly target: InputTarget,
    private readonly controller: InteractionController,
  ) {}

  mount(): void {
    if (this.abortController) return;
    const abortController = new AbortController();
    const options = { passive: true, signal: abortController.signal } as AddEventListenerOptions;
    this.abortController = abortController;

    this.target.addEventListener('touchstart', this.onTouchStart, options);
    this.target.addEventListener('touchmove', this.onTouchMove, options);
    this.target.addEventListener('touchend', this.onTouchEnd, options);
    this.target.addEventListener('touchcancel', this.onCancel, options);
    this.target.addEventListener('mousedown', this.onMouseDown, { signal: abortController.signal });
    this.target.addEventListener('mousemove', this.onMouseMove, { signal: abortController.signal });
    this.target.addEventListener('mouseup', this.onMouseUp, { signal: abortController.signal });
    this.target.addEventListener('mouseleave', this.onCancel, { signal: abortController.signal });
  }

  destroy(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.controller.cancel();
  }

  private onTouchStart = (event: Event): void => {
    const touchEvent = event as TouchEvent;
    if (isInteractiveTarget(touchEvent.target) || touchEvent.touches.length !== 1) return this.controller.cancel();
    this.ignoreMouseUntil = Date.now() + 700;
    const touch = touchEvent.touches[0];
    this.controller.start(point(touch.clientX, touch.clientY, touchEvent.timeStamp));
  };

  private onTouchMove = (event: Event): void => {
    const touchEvent = event as TouchEvent;
    if (touchEvent.touches.length !== 1) return this.controller.cancel();
    const touch = touchEvent.touches[0];
    this.controller.move(point(touch.clientX, touch.clientY, touchEvent.timeStamp));
  };

  private onTouchEnd = (event: Event): void => {
    const touchEvent = event as TouchEvent;
    const touch = touchEvent.changedTouches[0];
    if (!touch) return this.controller.cancel();
    this.controller.end(point(touch.clientX, touch.clientY, touchEvent.timeStamp));
  };

  private onMouseDown = (event: Event): void => {
    const mouseEvent = event as MouseEvent;
    if (isInteractiveTarget(mouseEvent.target) || mouseEvent.button !== 0 || Date.now() < this.ignoreMouseUntil) return;
    this.controller.start(point(mouseEvent.clientX, mouseEvent.clientY, mouseEvent.timeStamp));
  };

  private onMouseMove = (event: Event): void => {
    const mouseEvent = event as MouseEvent;
    if (mouseEvent.buttons !== 1) return;
    this.controller.move(point(mouseEvent.clientX, mouseEvent.clientY, mouseEvent.timeStamp));
  };

  private onMouseUp = (event: Event): void => {
    const mouseEvent = event as MouseEvent;
    this.controller.end(point(mouseEvent.clientX, mouseEvent.clientY, mouseEvent.timeStamp));
  };

  private onCancel = (): void => this.controller.cancel();
}

export class InputSurfaceSet {
  private surfaces = new Map<InputTarget, InputSurface>();

  constructor(private readonly controller: InteractionController) {}

  sync(targets: InputTarget[]): void {
    const next = new Set(targets);
    for (const [target, surface] of this.surfaces) {
      if (!next.has(target)) {
        surface.destroy();
        this.surfaces.delete(target);
      }
    }
    for (const target of next) {
      if (this.surfaces.has(target)) continue;
      const surface = new InputSurface(target, this.controller);
      surface.mount();
      this.surfaces.set(target, surface);
    }
  }

  destroy(): void {
    for (const surface of this.surfaces.values()) surface.destroy();
    this.surfaces.clear();
  }
}
