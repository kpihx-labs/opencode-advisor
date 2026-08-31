// btw.ts — /btw slash command for OpenCode
// Forked from u007/opencode-advisor/src/btw.ts, adapted for KπX sovereign plugin.
// Spawns an ephemeral sub-session to answer a by-the-way question without
// interrupting the currently running agent.

import type { Plugin } from "@opencode-ai/plugin";
import type { Part } from "@opencode-ai/sdk";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Load prompt from file ──────────────────────────────────────────────────

const __dirname = dirname( fileURLToPath( import.meta.url ) );

function loadPrompt( name: string ): string {
	const filePath = resolve( __dirname, "prompts", name );
	return readFileSync( filePath, "utf-8" ).trim();
}

const SYSTEM_PROMPT: string = loadPrompt( "btw.md" );

// ── Defaults ───────────────────────────────────────────────────────────────

const defaultModel: string = "deepseek/deepseek-v4-pro";

// ── Profile ────────────────────────────────────────────────────────────────

interface BtwProfile {
	model?: string;
}

function isPlainObject( v: unknown ): v is Record<string, unknown> {
	return ( "object" === typeof v ) && ( null !== v ) && !Array.isArray( v );
}

function parseBtwProfile( value: unknown ): BtwProfile {
	if( !isPlainObject( value ) ) return {};

	const profile: BtwProfile = {};
	const model: unknown = value.model;

	if( "string" === typeof model && model.includes( "/" ) ) {
		profile.model = model;
	}

	return profile;
}

// ── Model resolution (same cascade as advisor) ─────────────────────────────

function resolveBtwModel(
	profileModel: string | undefined,
	pluginCfg: { model?: string; agent?: { plan?: { model?: string } } } | undefined,
): { providerID: string; modelID: string } {
	let raw: string = defaultModel;

	if( profileModel ) {
		raw = profileModel;
	} else if( "string" === typeof pluginCfg?.agent?.plan?.model && pluginCfg.agent.plan.model.includes( "/" ) ) {
		raw = pluginCfg.agent.plan.model;
	} else if( "string" === typeof pluginCfg?.model && pluginCfg.model.includes( "/" ) ) {
		raw = pluginCfg.model;
	}

	const slashIdx: number = raw.indexOf( "/" );
	if( slashIdx > 0 && slashIdx < raw.length - 1 ) {
		return { providerID: raw.slice( 0, slashIdx ), modelID: raw.slice( slashIdx + 1 ) };
	}
	return { providerID: "deepseek", modelID: "deepseek-v4-pro" };
}

// ── Helpers ────────────────────────────────────────────────────────────────

// Minimal text part for output injection — no sessionID/messageID needed
function textPart( t: string ): { type: "text"; text: string } {
	return { type: "text", text: t };
}

// Cast helper — output.parts is Part[] but we only need text parts
function pushText( parts: Array<{ type: string }>, t: string ): void {
	parts.push( textPart( t ) as unknown as { type: string } );
}

// ── Recursion guard ────────────────────────────────────────────────────────

let inBtwCall: boolean = false;

// ── Plugin ─────────────────────────────────────────────────────────────────

export const BtwPlugin: Plugin = async ( { client }, rawOptions ) => {
	const btwProfile: BtwProfile = parseBtwProfile( rawOptions );
	let resolvedCfg: { model?: string; agent?: { plan?: { model?: string } } } | undefined;
	let activeBtwModel: { providerID: string; modelID: string } = resolveBtwModel( undefined, undefined );

	// Resolve model from profile → config → default
	function updateModel(): void {
		activeBtwModel = resolveBtwModel( btwProfile.model, resolvedCfg );
	}

	async function fetchTranscript( sessionID: string ): Promise<string> {
		const { data: messages } = await client.session.messages( {
			path: { id: sessionID },
		} );

		return ( messages ?? [] )
			.filter( ( m: { info: { role: string; id: string }; parts: Array<{ type: string; text?: string }> } ) => {
				// Keep assistant messages; filter out /btw user messages
				if( m.info.role !== "user" ) return true;
				return !m.parts.some(
					( p: { type: string; text?: string } ) =>
						"text" === p.type && typeof p.text === "string" && p.text.toLowerCase().startsWith( "/btw" ),
				);
			} )
			.map( ( m: { info: { role: string }; parts: Array<{ type: string; text?: string }> } ) => {
				const text: string = m.parts
					.filter( ( p: { type: string; text?: string } ) => "text" === p.type )
					.map( ( p: { type: string; text?: string } ) => p.text ?? "" )
					.join( "" );
				const role: string = "user" === m.info.role ? "User" : "Assistant";
				return `${role}: ${text}`;
			} )
			.filter( ( s: string ) => s.split( ": " )[ 1 ]?.length > 0 )
			.join( "\n\n" );
	}

	async function processBtw( sessionID: string, query: string ): Promise<void> {
		inBtwCall = true;
		try {
			const transcript: string = await fetchTranscript( sessionID );

			const promptParts: string[] = [];
			promptParts.push( SYSTEM_PROMPT + "\n\n" );
			if( transcript ) {
				promptParts.push( `--- CONVERSATION CONTEXT ---\n\n${transcript}\n\n` );
			}
			promptParts.push( `--- QUESTION ---\n\n${query}` );

			const createRes = await client.session.create( {
				body: { title: "btw-subcall" },
			} );
			const tempID: string | undefined = createRes.data?.id;
			if( !tempID ) {
				console.error( "btw: ephemeral session creation returned no ID" );
				return;
			}

			let answerText: string = "BTW returned no answer.";
			try {
				const response = await client.session.prompt( {
					path: { id: tempID },
					body: {
						model: activeBtwModel,
						parts: [ textPart( promptParts.join( "" ) ) ],
					},
				} );

				answerText = response.data?.parts
					?.filter( ( p: { type: string; text?: string } ) => "text" === p.type )
					.map( ( p: { type: string; text?: string } ) => p.text ?? "" )
					.join( "\n" ) || "BTW returned no answer.";
			} finally {
				await client.session
					.delete( { path: { id: tempID } } )
					.catch( ( e: unknown ) => console.error( "btw: failed to delete ephemeral session", e ) );
			}

			// Append answer as a card to the main session (noReply = true)
			await client.session.prompt( {
				path: { id: sessionID },
				body: {
					parts: [ textPart( `---\n**BTW:** ${query}\n\n${answerText}\n---` ) ],
				},
			} ).catch( ( e: unknown ) => console.error( "btw: failed to append card", e ) );
		} finally {
			inBtwCall = false;
		}
	}

	return {
		config: async ( cfg: { model?: string; agent?: { plan?: { model?: string } } } ): Promise<void> => {
			resolvedCfg = cfg;
			updateModel();
		},

		"command.execute.before": async (
			input: { command: string; sessionID: string; arguments: string },
			output: { parts: Part[] },
		): Promise<void> => {
			if( "btw" !== input.command ) return;

			if( inBtwCall ) {
				pushText( output.parts, "Error: /btw cannot be called recursively." );
				return;
			}

			const query: string = ( input.arguments ?? "" ).trim();
			if( !query ) {
				pushText( output.parts, "Error: empty /btw query. Usage: /btw <question>" );
				return;
			}

			// Acknowledge immediately — agent continues working
			pushText( output.parts, `[BTW] ${query}...` );

			// Fire-and-forget: process in background
			processBtw( input.sessionID, query ).catch( ( e: unknown ) => console.error( "btw:", e ) );
		},
	};
};

export default BtwPlugin;
