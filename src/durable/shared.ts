export interface PublishMessage {
	id: string;
	publisherId: string;
	content: MessageContent;
}

export interface MessageContent {
	ticker: string;
	value: number;
}
