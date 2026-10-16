/**
 * tailwind.config.js is plain JavaScript; typefaces.spec.ts reads its font
 * stacks (N-149). Only the part the test reads is declared.
 */
declare module '*tailwind.config.js' {
  const config: { theme: { extend: { fontFamily: Record<string, string[]> } } };
  export default config;
}
