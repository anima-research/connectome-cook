/** Remove repository-routing controls before Git's supported configuration
 * channels (and any source credential) are injected. Strip the entire GIT_
 * namespace rather than querying Git with an as-yet unfiltered environment.
 * Callers must not apply this function after sourceGitEnvironment. */
export function repositoryIndependentGitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_')) delete env[name];
  }
  return env;
}
