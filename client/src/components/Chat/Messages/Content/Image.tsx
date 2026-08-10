import React, { useState, useRef, useMemo, useEffect, useCallback } from 'react';
// [knauf] Recover image bytes through authenticated file routes when direct URLs fail or expire. (NO-TICKET)
import { useRecoilValue } from 'recoil';
import { useFileDownload, useSharedFileDownload } from '~/data-provider';
import { useShareContext } from '~/Providers';
import store from '~/store';
// End [knauf]
import { Skeleton } from '@librechat/client';
import { apiBaseUrl } from 'librechat-data-provider';
import DialogImage from './DialogImage';
import { cn } from '~/utils';

/** Max display height for chat images (Tailwind JIT class) */
export const IMAGE_MAX_H = 'max-h-[45vh]' as const;
/** Matches the `max-w-lg` Tailwind class on the wrapper button (32rem = 512px at 16px base) */
const IMAGE_MAX_W_PX = 512;

// [knauf] Refresh shortly before SAS expiry so the dialog load cannot race the token deadline. (NO-TICKET)
const needsAuthenticatedRecovery = (url: string): boolean => {
  try {
    const expiresAt = new URL(url, window.location.origin).searchParams.get('se');
    return expiresAt != null && Date.parse(expiresAt) <= Date.now() + 60_000;
  } catch {
    return false;
  }
};
// End [knauf]

/** Caches image dimensions by src so remounts can reserve space */
const dimensionCache = new Map<string, { width: number; height: number }>();
/** Tracks URLs that have been fully painted — skip skeleton on remount */
const paintedUrls = new Set<string>();

/** Test-only: resets module-level caches */
export function _resetImageCaches(): void {
  dimensionCache.clear();
  paintedUrls.clear();
}

function computeHeightStyle(w: number, h: number): React.CSSProperties {
  return { height: `min(45vh, ${(h / w) * 100}vw, ${(h / w) * IMAGE_MAX_W_PX}px)` };
}

const Image = ({
  imagePath,
  altText,
  className,
  args,
  width,
  height,
  // [knauf] Stable file identity is required for authenticated URL recovery. (NO-TICKET)
  fileId,
  // End [knauf]
}: {
  imagePath: string;
  altText: string;
  className?: string;
  args?: {
    prompt?: string;
    quality?: 'low' | 'medium' | 'high';
    size?: string;
    style?: string;
    [key: string]: unknown;
  };
  width?: number;
  height?: number;
  // [knauf] Stable file identity is required for authenticated URL recovery. (NO-TICKET)
  fileId?: string;
  // End [knauf]
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const absoluteImageUrl = useMemo(() => {
    if (!imagePath) return imagePath;

    if (imagePath.startsWith('http') || imagePath.startsWith('data:')) {
      return imagePath;
    }

    // Root-relative server paths (`/images/...` static, `/api/share/...` share
    // routes) are resolved against the API base so they load under a subpath.
    if (imagePath.startsWith('/images/') || imagePath.startsWith('/api/')) {
      return `${apiBaseUrl()}${imagePath}`;
    }

    return imagePath;
  }, [imagePath]);

  // [knauf] Browser image tags cannot attach the bearer token, and Azure SAS URLs expire while
  // a page stays open. On failure (or near-expiry dialog open), replace the direct URL with the
  // existing authenticated owned/shared download query's blob URL. (NO-TICKET)
  const user = useRecoilValue(store.user);
  const { shareId } = useShareContext();
  const { refetch: downloadOwned } = useFileDownload(user?.id ?? '', fileId, { direct: false });
  const { refetch: downloadShared } = useSharedFileDownload(shareId, fileId);
  const useShared = !!shareId && imagePath.startsWith('/api/share/');
  const downloadFile = useShared ? downloadShared : downloadOwned;
  const [recoveredImage, setRecoveredImage] = useState<{ source: string; url: string } | null>(
    null,
  );
  const recoveringRef = useRef(false);
  const imageUrl =
    recoveredImage?.source === absoluteImageUrl ? recoveredImage.url : absoluteImageUrl;

  const recoverImage = useCallback(async () => {
    if (!fileId || recoveringRef.current || recoveredImage?.source === absoluteImageUrl) {
      return;
    }
    recoveringRef.current = true;
    try {
      const result = await downloadFile();
      if (result.data) {
        setRecoveredImage({ source: absoluteImageUrl, url: result.data });
      }
    } finally {
      recoveringRef.current = false;
    }
  }, [absoluteImageUrl, downloadFile, fileId, recoveredImage?.source]);
  // End [knauf]

  const downloadImage = async () => {
    try {
      const response = await fetch(imageUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch image: ${response.status}`);
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.href = url;
      link.download = altText || 'image.png';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Download failed:', error);
      const link = document.createElement('a');
      link.href = imageUrl;
      link.download = altText || 'image.png';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  useEffect(() => {
    if (width && height && absoluteImageUrl) {
      dimensionCache.set(absoluteImageUrl, { width, height });
    }
  }, [absoluteImageUrl, width, height]);

  const dims = width && height ? { width, height } : dimensionCache.get(absoluteImageUrl);
  const hasDimensions = !!(dims?.width && dims?.height);
  const heightStyle = hasDimensions ? computeHeightStyle(dims.width, dims.height) : undefined;
  const showSkeleton = hasDimensions && !paintedUrls.has(absoluteImageUrl);

  return (
    <div>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`View ${altText} in dialog`}
        aria-haspopup="dialog"
        onClick={() => {
          setIsOpen(true);
          // [knauf] A thumbnail may still be painted after its backing SAS has expired. (NO-TICKET)
          if (needsAuthenticatedRecovery(absoluteImageUrl)) {
            void recoverImage();
          }
          // End [knauf]
        }}
        className={cn(
          'relative mt-1 w-full max-w-lg cursor-pointer overflow-hidden rounded-lg border border-border-light text-text-secondary-alt shadow-md transition-shadow',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-primary',
          className,
        )}
        style={heightStyle}
      >
        {showSkeleton && <Skeleton className="absolute inset-0" aria-hidden="true" />}
        <img
          alt={altText}
          src={imageUrl}
          // [knauf] Shared image routes can fail before router-level cookie auth; retry with bearer auth. (NO-TICKET)
          onError={() => void recoverImage()}
          // End [knauf]
          onLoad={() => paintedUrls.add(absoluteImageUrl)}
          className={cn(
            'relative block text-transparent',
            hasDimensions
              ? 'size-full object-contain'
              : cn('h-auto w-auto max-w-full', IMAGE_MAX_H),
          )}
        />
      </button>
      <DialogImage
        isOpen={isOpen}
        onOpenChange={setIsOpen}
        src={imageUrl}
        downloadImage={downloadImage}
        args={args}
        triggerRef={triggerRef}
      />
    </div>
  );
};

export default Image;
