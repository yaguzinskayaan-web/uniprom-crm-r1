import { useEffect, useState } from 'react';
import { BRAND } from '@/brand';

type BrandMarkProps = {
  /** Высота знака в пикселях. */
  size?: number;
  /**
   * `mark` — знак «У» для квадратной плитки (сайдбар, шапка карточки входа);
   * `lockup` — знак с надписью, ширина пропорциональна высоте.
   */
  variant?: 'mark' | 'lockup';
  title?: string;
};

/** Пропорции совпадают с viewBox файлов: знак 19.4×25.2, лок-ап 113×24. */
const ASPECT = { mark: 19.4 / 25.2, lockup: 113 / 24 } as const;

/**
 * A46: знак бренда. Показывает файл из `public/brand`, если он подложен;
 * иначе — текстовый знак с теми же пропорциями. Проверка выполняется один раз
 * и кешируется, чтобы не было повторных запросов.
 */
export function BrandMark({ size = 34, variant = 'mark', title }: BrandMarkProps) {
  const [logoOk, setLogoOk] = useState<boolean | null>(null);
  const src = variant === 'lockup' ? BRAND.lockupPath : BRAND.logoPath;

  useEffect(() => {
    let alive = true;
    setLogoOk(null);
    const img = new Image();
    img.onload = () => {
      if (alive) setLogoOk(true);
    };
    img.onerror = () => {
      if (alive) setLogoOk(false);
    };
    img.src = src;
    return () => {
      alive = false;
    };
  }, [src]);

  const style =
    variant === 'lockup'
      ? { width: Math.round(size * ASPECT.lockup), height: size }
      : { width: size, height: size, fontSize: Math.round(size * 0.5) };

  const className =
    'brand-mark' + (variant === 'lockup' ? ' brand-mark--lockup' : '') + (logoOk === true ? ' brand-mark--image' : '');

  if (logoOk === false) {
    return (
      <span className={className} style={style} role="img" aria-label={title ?? BRAND.name}>
        {BRAND.letterMark}
      </span>
    );
  }

  return (
    <span className={className} style={style} role="img" aria-label={title ?? BRAND.name}>
      {logoOk === true ? <img src={src} alt="" /> : null}
    </span>
  );
}