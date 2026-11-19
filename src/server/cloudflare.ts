export interface CloudflareDnsResult {
  success: boolean;
  recordId?: string;
  error?: string;
  proxied?: boolean;
}

export async function configureCloudflareSubdomain(options: {
  hostname: string;
  apiToken?: string | null;
  zoneId?: string | null;
  target?: string | null;
}): Promise<CloudflareDnsResult> {
  const token = (options.apiToken || process.env.CLOUDFLARE_API_TOKEN || '').trim();
  const zoneId = (options.zoneId || process.env.CLOUDFLARE_ZONE_ID || '').trim();

  if (!token || !zoneId) {
    // Return success since the domain is saved locally in DB, with informative note
    return {
      success: true,
      error: !token
        ? 'Domain registered locally. Add Cloudflare API Token in settings for auto-DNS provisioning.'
        : 'Domain registered locally. Add Cloudflare Zone ID in settings for auto-DNS provisioning.',
      proxied: false,
    };
  }

  const cleanHost = options.hostname
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  const target = (options.target || process.env.CLOUDFLARE_TARGET_CNAME || 'nasirlink.com')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');

  try {
    // 1. Check if DNS record already exists in the Zone
    const listRes = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/dns_records?name=${encodeURIComponent(cleanHost)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (listRes.ok) {
      const listData = (await listRes.json()) as any;
      if (Array.isArray(listData.result) && listData.result.length > 0) {
        return {
          success: true,
          recordId: listData.result[0].id,
          proxied: Boolean(listData.result[0].proxied),
        };
      }
    }

    // 2. Create new Proxied CNAME record on Cloudflare
    const createRes = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/dns_records`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'CNAME',
          name: cleanHost,
          content: target,
          ttl: 1, // Auto TTL
          proxied: true, // Orange cloud ☁️ for SSL & automatic Worker routing
        }),
      }
    );

    const createData = (await createRes.json()) as any;
    if (createRes.ok && createData.success) {
      return {
        success: true,
        recordId: createData.result?.id,
        proxied: true,
      };
    } else {
      const errMsg =
        createData.errors?.[0]?.message || 'Failed to create DNS record on Cloudflare';
      return {
        success: false,
        error: errMsg,
      };
    }
  } catch (err) {
    return {
      success: false,
      error: (err as Error).message,
    };
  }
}
