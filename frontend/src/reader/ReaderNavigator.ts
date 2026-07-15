import type { NavigationDirection } from '../interaction/InteractionController';

export interface ReaderNavigator {
  navigate(direction: NavigationDirection): Promise<boolean>;
}

export class SerialReaderNavigator implements ReaderNavigator {
  private navigating = false;

  constructor(
    private readonly previous: () => void | Promise<unknown>,
    private readonly next: () => void | Promise<unknown>,
  ) {}

  async navigate(direction: NavigationDirection): Promise<boolean> {
    if (this.navigating) return false;
    this.navigating = true;
    try {
      await (direction === 'next' ? this.next() : this.previous());
      return true;
    } catch (error) {
      console.error(`[ReaderNavigator] ${direction} failed`, error);
      return false;
    } finally {
      this.navigating = false;
    }
  }
}
