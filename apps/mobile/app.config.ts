import type { ExpoConfig } from "expo/config";

const devScheme = process.env.HIVE_MOBILE_DEV_SCHEME === "1";
const apiUrl = process.env.HIVE_API_URL ?? "https://api.example.com";
const host = new URL(apiUrl).hostname;

const config: ExpoConfig = {
  name: "hive",
  slug: "hive-mobile",
  version: "0.0.1",
  orientation: "portrait",
  userInterfaceStyle: "dark",
  ...(devScheme ? { scheme: "hive" } : {}),
  android: {
    package: "com.hive.mobile",
    ...(process.env.HIVE_GOOGLE_SERVICES_FILE
      ? { googleServicesFile: process.env.HIVE_GOOGLE_SERVICES_FILE }
      : {}),
    intentFilters: [
      {
        action: "VIEW",
        autoVerify: true,
        data: [{ scheme: "https", host, pathPrefix: "/mobile/callback" }],
        category: ["BROWSABLE", "DEFAULT"],
      },
    ],
  },
  plugins: ["expo-secure-store", "expo-web-browser", "expo-notifications"],
  extra: { apiUrl: process.env.HIVE_API_URL ?? "", devScheme },
};
export default config;
