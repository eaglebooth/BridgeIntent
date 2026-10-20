/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BRIDGEINTENT_ADDRESS: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
