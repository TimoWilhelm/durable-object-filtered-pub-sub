import { Temporal } from "temporal-polyfill";

export interface PublishMessage {
	id: string;
	publisherId: string;
	content: MessageContent;
}

export interface MessageContent {
	ticker: string;
	value: number;
}


export const PING_INTERVAL = Temporal.Duration.from({ seconds: 10 });
export const PING_TIMEOUT = Temporal.Duration.from({ seconds: 30 });
