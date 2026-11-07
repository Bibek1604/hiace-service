'use client';
import { useEffect } from 'react';

const PLACEHOLDER = '/image-unavailable.svg';

/** Replaces any uploaded image that fails to load, wherever it appears, with a clear placeholder. */
export function ImageFallback() {
  useEffect(() => {
    const onError = (event: Event) => {
      const image = event.target;
      if (!(image instanceof HTMLImageElement) || !image.src.includes('/api/images/')) return;
      image.src = PLACEHOLDER;
      image.alt = 'Image not available';
    };
    // Load errors do not bubble, so this listens in the capture phase.
    document.addEventListener('error', onError, true);
    return () => document.removeEventListener('error', onError, true);
  }, []);
  return null;
}
