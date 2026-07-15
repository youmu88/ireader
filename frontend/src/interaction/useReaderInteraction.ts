import { useCallback, useEffect, useRef } from 'react';
import { InputSurface, InputSurfaceSet, type InputTarget } from './InputSurface';
import { InteractionController, type NavigationDirection } from './InteractionController';

export interface ReaderInteractionHandlers {
  navigate: (direction: NavigationDirection) => void | Promise<unknown>;
  tap?: () => void;
  enabled?: () => boolean;
}

export function useReaderInteraction(handlers: ReaderInteractionHandlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const controllerRef = useRef<InteractionController>();

  if (!controllerRef.current) {
    controllerRef.current = new InteractionController({
      navigate: (direction) => handlersRef.current.navigate(direction),
      tap: () => handlersRef.current.tap?.(),
      enabled: () => handlersRef.current.enabled?.() ?? true,
    });
  }

  const elementSurfaceRef = useRef<InputSurface | null>(null);
  const surfaceSetRef = useRef<InputSurfaceSet>();
  if (!surfaceSetRef.current) surfaceSetRef.current = new InputSurfaceSet(controllerRef.current);

  const attachElement = useCallback((element: HTMLElement | null) => {
    elementSurfaceRef.current?.destroy();
    elementSurfaceRef.current = null;
    if (!element) return;
    const surface = new InputSurface(element, controllerRef.current!);
    surface.mount();
    elementSurfaceRef.current = surface;
  }, []);

  const syncTargets = useCallback((targets: InputTarget[]) => {
    surfaceSetRef.current!.sync(targets);
  }, []);

  useEffect(() => () => {
    elementSurfaceRef.current?.destroy();
    surfaceSetRef.current?.destroy();
  }, []);

  return { attachElement, syncTargets };
}
