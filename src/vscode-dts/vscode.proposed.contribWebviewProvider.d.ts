/*---------------------------------------------------------------------------------------------
 *  Proposed API: contribWebviewProvider
 *  Allows extensions to register webview view providers via window.registerWebviewProvider.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {
	export namespace window {
		/**
		 * Register a provider for a webview view (proposed API alias for registerWebviewViewProvider).
		 *
		 * @param viewId Unique id of the view.
		 * @param provider A {@link WebviewViewProvider}.
		 * @param options Options for the webview view.
		 * @returns A {@link Disposable} that unregisters the provider.
		 */
		export function registerWebviewProvider(viewId: string, provider: WebviewViewProvider, options?: {
			/**
			 * Content settings for the webview created for this view.
			 */
			readonly webviewOptions?: {
				/**
				 * Controls if the webview element itself (iframe) is kept around even when the view
				 * is no longer visible.
				 */
				readonly retainContextWhenHidden?: boolean;
			};
		}): Disposable;
	}
}
