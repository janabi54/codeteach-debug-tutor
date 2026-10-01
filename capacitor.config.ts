import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.codeteach.debug',
  appName: 'CodeTeach',
  webDir: 'public',
  server: {
    url: 'http://10.0.0.191:3001',
    cleartext: true
  }
};

export default config;
