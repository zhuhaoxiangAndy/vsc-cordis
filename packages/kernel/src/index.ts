export { EffectStack } from './effect-stack.ts'
export type { EffectStackOptions } from './effect-stack.ts'

export { ServiceRegistry } from './service-registry.ts'
export type { RegistryListener, ServiceChangeEvent, ServiceProviderRecord } from './service-registry.ts'

export { PluginHost, describe } from './plugin-host.ts'
export type {
  PluginHostOptions,
  PluginRecord,
  PluginState,
  PluginView,
  TransitionEvent,
} from './plugin-host.ts'

export { asPluginManifest, isSafeRelativePath, validateManifest } from './manifest.ts'
export type { ManifestValidation, NormalizedManifest } from './manifest.ts'

export { createPluginContext } from './context.ts'
export type { PluginContextDeps } from './context.ts'

export type { CreateApiDeps, HostPort, LoadedPluginModule, PluginEntry, PluginSource } from './ports.ts'

export { isValidRange, parseVersion, satisfies } from './semver-mini.ts'
export { KERNEL_PERMISSIONS, isKnownPermission } from './permissions.ts'
export { TimeoutError, withTimeout } from './timing.ts'

export {
  InvalidManifestError,
  IsolationUnavailableError,
  PermissionDeniedError,
  PluginAlreadyLoadedError,
  PluginEngineMismatchError,
  ServiceConflictError,
  ServiceUnavailableError,
  ServiceVersionMismatchError,
  VscordisError,
} from './errors.ts'
