import type { SVGProps } from "react";

const base = (d: string | string[]) =>
  function Icon(props: SVGProps<SVGSVGElement>) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...props}>
        {(Array.isArray(d) ? d : [d]).map((p, i) => (
          <path key={i} d={p} />
        ))}
      </svg>
    );
  };

export const IconHome = base(["M3 11l9-7 9 7", "M5 10v10h14V10"]);
export const IconVideo = base(["M3 6h13v12H3z", "M16 10l5-3v10l-5-3"]);
export const IconLive = base(["M12 12h.01", "M8.5 8.5a5 5 0 0 0 0 7", "M15.5 8.5a5 5 0 0 1 0 7", "M5.6 5.6a9 9 0 0 0 0 12.8", "M18.4 5.6a9 9 0 0 1 0 12.8"]);
export const IconChart = base(["M4 20V10", "M10 20V4", "M16 20v-7", "M22 20H2"]);
export const IconHook = base(["M18 16.5a3.5 3.5 0 1 1-3.2-5", "M9 7.5A3.5 3.5 0 1 1 12 12l3 6", "M6.2 13.5A3.5 3.5 0 1 0 9 19h6"]);
export const IconKey = base(["M15.5 7.5a3.5 3.5 0 1 1-5 5L4 19v2h3v-2h2v-2h2l1.5-1.5", "M16 8h.01"]);
export const IconShield = base(["M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z", "M9 12l2 2 4-4"]);
export const IconGauge = base(["M12 14l4-4", "M3.3 17a10 10 0 1 1 17.4 0"]);
export const IconSettings = base(["M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"]);
export const IconSign = base(["M4 20h16", "M6 16l9.5-9.5a2.1 2.1 0 0 1 3 3L9 19H6z"]);
export const IconBook = base(["M4 19.5A2.5 2.5 0 0 1 6.5 17H20", "M6.5 3H20v18H6.5A2.5 2.5 0 0 1 4 18.5v-13A2.5 2.5 0 0 1 6.5 3z", "M9 7.5h7"]);
export const IconUpload = base(["M12 16V4", "M7 9l5-5 5 5", "M4 20h16"]);
export const IconPlus = base(["M12 5v14", "M5 12h14"]);
export const IconMenu = base(["M4 7h16", "M4 12h16", "M4 17h16"]);
export const IconTrash = base(["M4 7h16", "M9 7V4h6v3", "M6 7l1 13h10l1-13"]);
export const IconLink = base(["M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1", "M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"]);
export const IconLogout = base(["M15 4h4v16h-4", "M10 16l-4-4 4-4", "M6 12h10"]);
