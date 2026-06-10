import type { CSSProperties } from 'react';
import { cn } from '~/utils';

type KnaufLogoAvatarProps = {
  alt?: string;
  className?: string;
  imageClassName?: string;
  style?: CSSProperties;
};

export default function KnaufLogoAvatar({
  alt = 'Knauf',
  className,
  imageClassName,
  style,
}: Readonly<KnaufLogoAvatarProps>) {
  return (
    <div
      className={cn(
        'shadow-stroke flex h-full w-full items-center justify-center overflow-hidden rounded-full bg-white text-black',
        className,
      )}
      style={style}
    >
      <img
        src="/assets/knauf-logo.png"
        alt={alt}
        className={cn('h-auto w-[72%] object-contain', imageClassName)}
        loading="lazy"
        decoding="async"
      />
    </div>
  );
}
