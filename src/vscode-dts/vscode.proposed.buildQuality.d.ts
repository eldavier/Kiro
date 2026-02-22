/*---------------------------------------------------------------------------------------------
 *  Proposed API: buildQuality
 *  Exposes the build quality (stable, insider, dev) on the env namespace.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {
	export namespace env {
		/**
		 * The build quality of the application (e.g., 'stable', 'insider', 'dev').
		 */
		export const buildQuality: string | undefined;
	}
}
