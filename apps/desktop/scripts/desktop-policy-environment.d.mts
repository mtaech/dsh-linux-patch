/** Required deployment-selected metadata for mandatory-update policy requests. */
export interface DesktopPolicyEnvironment {
  origin: string
  allowedPageOrigins: string[]
  allowedAuthOrigins?: string[]
  authentication: 'anonymous' | 'feishu-test'
  [key: string]: unknown
}

/**
 * Resolve policy settings before artifact preparation or signing.
 *
 * The Desktop runtime enforces mandatory updates on macOS and Windows only, so another target
 * carries no policy metadata and none of its settings are required.
 * @param environment File-owned release settings; only the selected origin is required.
 * @param platform Distribution platform this package targets.
 * @returns Policy metadata with deployment-selected origin and authentication, or undefined when the platform has none.
 */
export function resolveDesktopPolicyEnvironment(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): DesktopPolicyEnvironment | undefined
