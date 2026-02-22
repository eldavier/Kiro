/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ISignInController, ISignInService } from '../common/signInService.js';

export class SignInService extends Disposable implements ISignInService {
	declare readonly _serviceBrand: undefined;

	private readonly _signInControllers = new Map<string, { controller: ISignInController; options?: { isInternalUser?: boolean } }>();

	constructor(
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	registerSignInController(providerId: string, controller: ISignInController, options?: { isInternalUser?: boolean }): void {
		if (this._signInControllers.has(providerId)) {
			this.logService.warn(`A sign-in controller for provider '${providerId}' is already registered.`);
			return;
		}
		this._signInControllers.set(providerId, { controller, options });
		this.logService.info(`Sign-in controller registered for provider '${providerId}'.`);
	}

	unregisterSignInController(providerId: string): void {
		if (this._signInControllers.delete(providerId)) {
			this.logService.info(`Sign-in controller unregistered for provider '${providerId}'.`);
		}
	}

	showSignInPage(providerId: string): void {
		const entry = this._signInControllers.get(providerId);
		if (!entry) {
			this.logService.warn(`No sign-in controller found for provider '${providerId}'.`);
			return;
		}
		this.logService.info(`Showing sign-in page for provider '${providerId}'.`);
		// The sign-in page display is handled by the extension through the onDidReceiveSignInRequest event.
		// The $sendDidReceiveSignInRequest call in mainThreadAuthentication is what actually triggers
		// the ext host to fire the event. This method is called by other main-thread services that
		// want to initiate a sign-in flow.
	}

	getSignInController(providerId: string): ISignInController | undefined {
		return this._signInControllers.get(providerId)?.controller;
	}

	override dispose(): void {
		this._signInControllers.clear();
		super.dispose();
	}
}

registerSingleton(ISignInService, SignInService, InstantiationType.Delayed);
