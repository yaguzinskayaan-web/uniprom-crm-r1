/**
 * A46: фирменное оформление.
 *
 * Единый источник значений паспорта фирменного стиля. Палитра, радиусы и шрифт
 * дублируются в `styles.css` (`:root`) — при замене значений менять нужно оба
 * места, чтобы не разъехались.
 *
 * Логотип: файлы взяты с официального сайта https://uniprom.pro/ и положены в
 * `frontend/public/brand/`.
 *   - `logo.svg` — знак «У», для квадратной плитки; он градиентный и не зависит
 *     от фона подложки;
 *   - `logo-lockup.svg` — знак с надписью для светлого фона;
 *   - `logo-lockup-on-dark.svg` — то же для тёмного фона (надпись белая).
 * Пока файла нет, показывается текстовый знак с теми же пропорциями.
 */
export const BRAND = {
  name: 'Унипром',
  product: 'Унипром CRM',
  /** Утверждённый знак; null — если файл не подложен. */
  logoPath: '/brand/logo.svg',
  /** Знак с надписью для светлого фона. */
  lockupPath: '/brand/logo-lockup.svg',
  /** Знак с надписью для тёмного фона. */
  lockupPathOnDark: '/brand/logo-lockup-on-dark.svg',
  /** Текстовый знак, используемый до подкладывания утверждённого логотипа. */
  letterMark: 'У',
  colors: {
    // Градиент знака на сайте: #1BC4ED → #1189F4 → #0445FB.
    brand: '#1189f4',
    brandHover: '#0445fb',
    brandSoft: '#eef3ff',
    brandBorder: '#c9d9ff',
    text: '#242424',
    surface: '#ffffff',
    surfaceAlt: '#f7f7f7',
  },
  fontFamily: 'Manrope, system-ui, -apple-system, "Segoe UI", sans-serif',
} as const;