/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { AuthenticationSession } from './authentication.js';

/**
 * A sign-in controller that can handle sign-in requests on the main thread side.
 */
export interface ISignInController {
	signIn(providerConfiguration?: unknown): Promise<AuthenticationSession>;
	cancelSignIn(): void;
}

export const ISignInService = createDecorator<ISignInService>('ISignInService');

export interface ISignInService {
	readonly _serviceBrand: undefined;

	/**
	 * Register a sign-in controller for the given authentication provider.
	 */
	registerSignInController(providerId: string, controller: ISignInController, options?: { isInternalUser?: boolean }): void;

	/**
	 * Unregister a sign-in controller for the given authentication provider.
	 */
	unregisterSignInController(providerId: string): void;

	/**
	 * Show the sign-in page for the given authentication provider.
	 * This triggers the controller's onDidReceiveSignInRequest event on the extension host side.
	 */
	showSignInPage(providerId: string): void;

	/**
	 * Get a registered sign-in controller for the given provider.
	 */
	getSignInController(providerId: string): ISignInController | undefined;
}
