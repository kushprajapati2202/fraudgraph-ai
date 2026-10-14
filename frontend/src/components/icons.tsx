import type { ReactNode } from "react";

/** Minimal stroke icon set (24x24, currentColor). Decorative: always paired with a text label or aria-label. */
function Svg({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

type P = { size?: number };

export const IconOverview = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="3" width="7" height="9" rx="1.5" />
    <rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="12" width="7" height="9" rx="1.5" />
    <rect x="3" y="16" width="7" height="5" rx="1.5" />
  </Svg>
);
export const IconCases = (p: P) => (
  <Svg {...p}>
    <path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.800-1-8-4.500-8-9V6l8-3z" />
    <path d="M9 12l2 2 4-4" />
  </Svg>
);
export const IconLock = (p: P) => (
  <Svg {...p}>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </Svg>
);
export const IconTransactions = (p: P) => (
  <Svg {...p}>
    <path d="M4 8h14l-3-3" />
    <path d="M20 16H6l3 3" />
  </Svg>
);
export const IconNetwork = (p: P) => (
  <Svg {...p}>
    <circle cx="6" cy="6" r="2.500" />
    <circle cx="18" cy="9" r="2.500" />
    <circle cx="9" cy="18" r="2.500" />
    <path d="M8.300 7l7.300 1.500M7 8.300l1.500 7.300M16.500 11l-6 5.500" />
  </Svg>
);
export const IconSimulator = (p: P) => (
  <Svg {...p}>
    <path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.800 3h10.400a2 2 0 0 0 1.800-3l-5-9V3" />
    <path d="M7.500 14h9" />
  </Svg>
);
export const IconSettings = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.400 15a1.700 1.700 0 0 0 .300 1.900l.100.100a2 2 0 1 1-2.800 2.800l-.100-.100a1.700 1.700 0 0 0-1.900-.300 1.700 1.700 0 0 0-1 1.500V21a2 2 0 1 1-4 0v-.100a1.700 1.700 0 0 0-1-1.500 1.700 1.700 0 0 0-1.900.300l-.100.100a2 2 0 1 1-2.800-2.800l.100-.100a1.700 1.700 0 0 0 .300-1.900 1.700 1.700 0 0 0-1.500-1H3a2 2 0 1 1 0-4h.100a1.700 1.700 0 0 0 1.500-1 1.700 1.700 0 0 0-.300-1.900l-.100-.100a2 2 0 1 1 2.800-2.800l.100.100a1.700 1.700 0 0 0 1.900.300h.100a1.700 1.700 0 0 0 1-1.500V3a2 2 0 1 1 4 0v.100a1.700 1.700 0 0 0 1 1.500 1.700 1.700 0 0 0 1.900-.300l.100-.100a2 2 0 1 1 2.800 2.800l-.100.100a1.700 1.700 0 0 0-.300 1.900v.100a1.700 1.700 0 0 0 1.500 1H21a2 2 0 1 1 0 4h-.100a1.700 1.700 0 0 0-1.500 1z" />
  </Svg>
);
export const IconSearch = (p: P) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.500-3.500" />
  </Svg>
);
export const IconSun = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.900 4.900l1.400 1.400M17.700 17.700l1.400 1.400M2 12h2M20 12h2M4.900 19.100l1.400-1.400M17.700 6.300l1.400-1.400" />
  </Svg>
);
export const IconMoon = (p: P) => (
  <Svg {...p}>
    <path d="M21 12.800A9 9 0 1 1 11.200 3a7 7 0 0 0 9.800 9.800z" />
  </Svg>
);
export const IconPlay = (p: P) => (
  <Svg {...p}>
    <path d="M6 4l14 8-14 8V4z" />
  </Svg>
);
export const IconChevron = (p: P) => (
  <Svg {...p}>
    <path d="M9 6l6 6-6 6" />
  </Svg>
);
export const IconSparkle = (p: P) => (
  <Svg {...p}>
    <path d="M12 3l1.800 5.200L19 10l-5.200 1.800L12 17l-1.800-5.200L5 10l5.200-1.800L12 3z" />
    <path d="M19 15l.700 2 2 .700-2 .700-.700 2-.700-2-2-.700 2-.700.700-2z" />
  </Svg>
);
export const IconUser = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c0-4.400 3.600-7 8-7s8 2.600 8 7" />
  </Svg>
);
export const IconRefresh = (p: P) => (
  <Svg {...p}>
    <path d="M20 11a8 8 0 0 0-14.900-3M4 4v4h4" />
    <path d="M4 13a8 8 0 0 0 14.900 3M20 20v-4h-4" />
  </Svg>
);
export const IconClock = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Svg>
);
export const IconCog = (p: P) => (
  <Svg {...p}>
    <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" />
    <circle cx="16" cy="6" r="2" />
    <circle cx="10" cy="12" r="2" />
    <circle cx="18" cy="18" r="2" />
  </Svg>
);
export const IconFlow = (p: P) => (
  <Svg {...p}>
    <path d="M3 12h4l3-7 4 14 3-7h4" />
  </Svg>
);
