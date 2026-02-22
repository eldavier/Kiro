/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {

	/**
	 * A controller that handles sign-in requests for an authentication provider.
	 */
	export interface AuthenticationSignInController {
		/**
		 * An event that fires when a sign-in request is received.
		 */
		readonly onDidReceiveSignInRequest: Event<void>;

		/**
		 * Show the sign-in page.
		 */
		showSignInPage(): void;

		/**
		 * Sign in with the given provider configuration.
		 * @param providerConfiguration Optional provider-specific configuration.
		 * @returns A promise that resolves to the authentication session.
		 */
		signIn(providerConfiguration?: unknown): Thenable<AuthenticationSession>;

		/**
		 * Cancel the current sign-in flow.
		 */
		cancelSignIn(): void;
	}

	/**
	 * Options for registering a sign-in controller.
	 */
	export interface AuthenticationSignInControllerOptions {
		/**
		 * Whether the user is an internal user.
		 */
		isInternalUser?: boolean;
	}

	export namespace authentication {
		/**
		 * Register a sign-in controller for the given authentication provider.
		 * @param providerId The id of the authentication provider.
		 * @param controller The sign-in controller.
		 * @param options Optional options.
		 * @returns A disposable that unregisters the controller when disposed.
		 */
		export function registerSignInController(
			providerId: string,
			controller: AuthenticationSignInController,
			options?: AuthenticationSignInControllerOptions
		): Disposable;
	}
}
