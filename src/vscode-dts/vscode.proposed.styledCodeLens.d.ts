/*---------------------------------------------------------------------------------------------
 *  Proposed API: styledCodeLens
 *  Provides StyledCodeLens - a CodeLens subclass with render styling options.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {

	export interface StyledCodeLensRenderOptions {
		color?: ThemeColor;
		borderColor?: ThemeColor;
		fontSize?: number;
		iconSize?: number;
		actionPadding?: number;
		fontFamily?: string;
		indent?: number;
	}

	export class StyledCodeLens extends CodeLens {
		renderOptions: StyledCodeLensRenderOptions;
		constructor(renderOptions: StyledCodeLensRenderOptions, range: Range, command?: Command);
	}
}
