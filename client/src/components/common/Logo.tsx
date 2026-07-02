import { useEffect, useState } from 'react';

/**
 * Tracks the active theme (the `data-theme` attribute on <html>) so the logo can
 * swap variants live — e.g. when the user picks a theme in the ThemePicker or a
 * theme arrives via SSO — without a page reload.
 */
function useIsDaylight(): boolean {
  const [isDaylight, setIsDaylight] = useState(
    () => document.documentElement.dataset.theme === 'obli-daylight',
  );

  useEffect(() => {
    const el = document.documentElement;
    const sync = () => setIsDaylight(el.dataset.theme === 'obli-daylight');
    sync();
    const obs = new MutationObserver(sync);
    obs.observe(el, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);

  return isDaylight;
}

interface LogoProps {
  className?: string;
  alt?: string;
}

/**
 * Obliguard wordmark. Uses the black-text variant on the light Obli Daylight
 * theme (readable on a white surface) and the default white-text variant on the
 * dark themes.
 */
export function Logo({ className, alt = 'Obliguard' }: LogoProps) {
  const src = useIsDaylight() ? '/logo-daylight.svg' : '/logo.svg';
  return <img src={src} alt={alt} className={className} />;
}
