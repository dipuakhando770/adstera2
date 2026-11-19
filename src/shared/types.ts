export type UserRole = 'user' | 'admin';
export type UserStatus = 'active' | 'suspended';
export type LinkType = 'normal' | 'video';
export type RedirectStatusCode = 301 | 302;
export type ReportStatus = 'pending' | 'reviewed' | 'dismissed' | 'actioned';

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  status: UserStatus;
  emailVerified: boolean;
  createdAt: string;
}

export interface LinkRecord {
  id: string;
  userId: string | null;
  slug: string;
  shortCode?: string;
  linkType: LinkType;
  previewEnabled: boolean;
  autoRedirectSeconds: number;
  destinationUrl: string;
  videoUrl: string | null;
  videoTitle: string | null;
  videoDescription: string | null;
  thumbnailUrl: string | null;
  videoMimeType: string | null;
  videoWidth: number;
  videoHeight: number;
  twitterCardType: 'player' | 'summary_large_image';
  playerUrl: string | null;
  redirectType: RedirectStatusCode;
  hasPassword: boolean;
  expiresAt: string | null;
  isActive: boolean;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  campaignName: string | null;
  tags: string[];
  clicksCount: number;
  customDomainId?: string | null;
  customDomainHostname?: string | null;
  rotationMode?: 'fixed' | 'random_persistent' | 'scheduled';
  rotationIntervalHours?: number;
  metadataVariants?: Array<{
    id: string;
    title: string;
    description?: string | null;
    thumbnailUrl?: string | null;
    isActive?: boolean;
  }>;
  createdAt: string;
  updatedAt: string;
}

export interface CustomDomain {
  id: string;
  userId: string | null;
  hostname: string;
  cloudflareMode: 'zone' | 'saas';
  cloudflareZoneId: string | null;
  cloudflareHostnameId: string | null;
  dnsStatus: 'pending' | 'verified' | 'active' | 'failed';
  sslStatus: 'pending' | 'active' | 'failed';
  domainStatus: 'active' | 'suspended' | 'maintenance';
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MetadataValidationCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface VideoStreamAudit {
  videoReachable: boolean;
  videoStatus: number | null;
  videoHttps: boolean;
  videoMimeType: string | null;
  videoContentLength: number | null;
  acceptRanges: boolean;
  rangeSupported: boolean;
  rangeStatus: number | null;
  detectedWidth: number | null;
  detectedHeight: number | null;
  codec: string | null;
  faststart: boolean | null;
  isGithubRaw: boolean;
  xCrawlerReady: boolean;
  playerReachable: boolean;
  playerStatus: number | null;
  playerHttps: boolean;
  errors: string[];
  warnings: string[];
}

export interface SocialMetadataPreview {
  title: string;
  description: string;
  url: string;
  ogType: string;
  ogImage?: string;
  ogImageUrl?: string;
  ogImageSecureUrl?: string;
  ogImageType?: string;
  ogImageWidth?: number;
  ogImageHeight?: number;
  ogVideo: string;
  ogVideoUrl: string;
  ogVideoSecureUrl: string;
  ogVideoType: string;
  ogVideoWidth: number;
  ogVideoHeight: number;
  twitterCard: string;
  twitterTitle: string;
  twitterDescription: string;
  twitterImage?: string;
  twitterPlayer: string;
  twitterPlayerWidth: number;
  twitterPlayerHeight: number;
  twitterPlayerStream: string;
  twitterPlayerStreamContentType: string;
  sourceUrl?: string;
  sourceDomain?: string;
  hasValidVideo?: boolean;
  videoError?: string;
  renderedMetaHtml?: string;
  checks?: MetadataValidationCheck[];
}

export interface TimeSeriesPoint {
  label: string;
  clicks: number;
  uniqueVisitors: number;
}

export interface BreakdownItem {
  name: string;
  count: number;
  percentage: number;
}

export interface AnalyticsOverview {
  totals: {
    totalLinks: number;
    totalClicks: number;
    activeLinks: number;
    videoLinks: number;
    todaysClicks: number;
    uniqueVisitors: number;
  };
  clicksOverTime: TimeSeriesPoint[];
  hourlyClicks: TimeSeriesPoint[];
  topLinks: Array<{
    id: string;
    slug: string;
    linkType: LinkType;
    destinationUrl: string;
    clicks: number;
  }>;
  devices: BreakdownItem[];
  browsers: BreakdownItem[];
  operatingSystems: BreakdownItem[];
  referrers: BreakdownItem[];
  countries: BreakdownItem[];
}

export interface SystemSettings {
  siteName: string;
  domain: string;
  defaultRedirectType: RedirectStatusCode;
  registrationEnabled: boolean;
  maxLinksPerUser: number;
  rateLimitPerMin: number;
  maintenanceMode: boolean;
  globalVideoUrl: string | null;
  globalVideoWidth: number | null;
  globalVideoHeight: number | null;
  globalVideoMimeType: string | null;
  globalVideoTitle: string | null;
  globalVideoDescription: string | null;
  globalVideoSourceUrl: string | null;
  globalVideoOverride: boolean;
}

export interface AdminStats {
  totalUsers: number;
  totalLinks: number;
  totalVideoLinks: number;
  totalClicks: number;
  activeUsers: number;
  dailyRegistrations: Array<{ date: string; count: number }>;
  pendingReports: number;
}

export interface AbuseReport {
  id: string;
  linkId: string | null;
  slug: string;
  reason: string;
  details: string | null;
  status: ReportStatus;
  createdAt: string;
}
