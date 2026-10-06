/**
 * Sizes to start a design from, in pixels. Social sizes follow each platform's
 * recommended upload size; print sizes are at 300 ppi; phone wallpapers and contact
 * posters at a current iPhone Pro Max screen.
 */
/** `width × height` is one slide; carousels have `slides` of them side by side. */
export type SizePreset = { readonly id: string; readonly label: string; readonly width: number; readonly height: number; readonly group: SizeGroup; readonly tags?: readonly string[]; readonly slides?: number };
export type SizeGroup = "Social" | "Carousels" | "Phone & wallpaper" | "Video & web" | "Print" | "Business";

export const SIZE_GROUPS: readonly SizeGroup[] = ["Social", "Carousels", "Phone & wallpaper", "Video & web", "Print", "Business"];

export const SIZE_PRESETS: readonly SizePreset[] = [
  { id: "ig-square", label: "Instagram post", width: 1080, height: 1080, group: "Social", tags: ["instagram", "square", "post"] },
  { id: "ig-portrait", label: "Instagram portrait", width: 1080, height: 1350, group: "Social", tags: ["instagram", "post"] },
  { id: "ig-story", label: "Story / Reel", width: 1080, height: 1920, group: "Social", tags: ["instagram", "story", "reel", "tiktok"] },
  { id: "tiktok", label: "TikTok", width: 1080, height: 1920, group: "Social", tags: ["tiktok", "video"] },
  { id: "fb-post", label: "Facebook post", width: 1200, height: 1200, group: "Social", tags: ["facebook"] },
  { id: "fb-cover", label: "Facebook cover", width: 1640, height: 624, group: "Social", tags: ["facebook", "cover", "banner"] },
  { id: "x-post", label: "X post", width: 1600, height: 900, group: "Social", tags: ["twitter", "x"] },
  { id: "x-header", label: "X header", width: 1500, height: 500, group: "Social", tags: ["twitter", "x", "banner", "header"] },
  { id: "pinterest", label: "Pinterest pin", width: 1000, height: 1500, group: "Social", tags: ["pinterest"] },
  { id: "linkedin-post", label: "LinkedIn post", width: 1200, height: 1200, group: "Social", tags: ["linkedin"] },
  { id: "linkedin-banner", label: "LinkedIn banner", width: 1584, height: 396, group: "Social", tags: ["linkedin", "banner"] },
  { id: "profile", label: "Profile picture", width: 1080, height: 1080, group: "Social", tags: ["avatar", "profile"] },
  { id: "carousel-portrait-3", label: "Carousel 4:5, 3 slides", width: 1080, height: 1350, slides: 3, group: "Carousels", tags: ["carousel", "instagram", "swipe", "panorama", "slides"] },
  { id: "carousel-square-3", label: "Carousel square, 3 slides", width: 1080, height: 1080, slides: 3, group: "Carousels", tags: ["carousel", "instagram", "swipe", "panorama", "slides"] },
  { id: "carousel-portrait-5", label: "Carousel 4:5, 5 slides", width: 1080, height: 1350, slides: 5, group: "Carousels", tags: ["carousel", "instagram", "swipe", "slides"] },
  { id: "panorama-2", label: "Panorama, 2 slides", width: 1080, height: 1350, slides: 2, group: "Carousels", tags: ["carousel", "panorama", "seamless", "swipe"] },
  { id: "carousel-square-10", label: "Carousel square, 10 slides", width: 1080, height: 1080, slides: 10, group: "Carousels", tags: ["carousel", "instagram", "slides", "long"] },
  { id: "phone-wallpaper", label: "Phone wallpaper", width: 1290, height: 2796, group: "Phone & wallpaper", tags: ["wallpaper", "lock screen", "iphone"] },
  { id: "contact-poster", label: "Contact poster", width: 1290, height: 2796, group: "Phone & wallpaper", tags: ["contact", "poster", "iphone"] },
  { id: "desktop-wallpaper", label: "Desktop wallpaper", width: 3840, height: 2160, group: "Phone & wallpaper", tags: ["wallpaper", "desktop", "4k"] },
  { id: "tablet-wallpaper", label: "Tablet wallpaper", width: 2732, height: 2732, group: "Phone & wallpaper", tags: ["wallpaper", "ipad"] },
  { id: "yt-thumbnail", label: "YouTube thumbnail", width: 1280, height: 720, group: "Video & web", tags: ["youtube", "thumbnail"] },
  { id: "yt-banner", label: "YouTube banner", width: 2560, height: 1440, group: "Video & web", tags: ["youtube", "banner"] },
  { id: "twitch-banner", label: "Twitch banner", width: 1200, height: 480, group: "Video & web", tags: ["twitch", "banner"] },
  { id: "presentation", label: "Presentation 16:9", width: 1920, height: 1080, group: "Video & web", tags: ["slide", "presentation"] },
  { id: "web-banner", label: "Web banner", width: 1200, height: 628, group: "Video & web", tags: ["ad", "banner", "og"] },
  { id: "flyer-letter", label: "Flyer (US Letter)", width: 2550, height: 3300, group: "Print", tags: ["flyer", "letter"] },
  { id: "flyer-a4", label: "Flyer (A4)", width: 2480, height: 3508, group: "Print", tags: ["flyer", "a4"] },
  { id: "a5", label: "A5 leaflet", width: 1748, height: 2480, group: "Print", tags: ["leaflet", "a5"] },
  { id: "poster-18x24", label: "Poster 18 × 24 in", width: 5400, height: 7200, group: "Print", tags: ["poster"] },
  { id: "invitation", label: "Invitation 5 × 7 in", width: 1500, height: 2100, group: "Print", tags: ["invitation", "card", "birthday", "wedding"] },
  { id: "postcard", label: "Postcard 6 × 4 in", width: 1800, height: 1200, group: "Print", tags: ["postcard"] },
  { id: "business-card", label: "Business card", width: 1050, height: 600, group: "Business", tags: ["business card"] },
  { id: "logo", label: "Logo", width: 2000, height: 2000, group: "Business", tags: ["logo", "brand"] },
  { id: "menu", label: "Menu", width: 2550, height: 3300, group: "Business", tags: ["menu", "restaurant"] },
  { id: "certificate", label: "Certificate", width: 3300, height: 2550, group: "Business", tags: ["certificate", "award"] },
];

export const presetById = (id: string) => SIZE_PRESETS.find((p) => p.id === id);

/** "1080 × 1350 px", or "3 × 1080 × 1350 px" for a carousel's slides. */
export const sizeLabel = (w: number, h: number, slides = 1) => `${slides > 1 ? `${slides} × ` : ""}${w} × ${h} px`;
