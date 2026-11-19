// OpenNext Cloudflare Adapter Configuration
// Install @opennextjs/cloudflare when deploying via Next.js/OpenNext to Cloudflare Workers

const config = {
  default: {
    override: {
      wrapper: 'cloudflare-node',
      converter: 'edge',
      proxyExternalRequest: 'fetch',
      incrementalCache: 'dummy',
      tagCache: 'dummy',
      queue: 'dummy',
    },
  },
};

export default config;
