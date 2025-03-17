// MCP Server Types for Unity Integration

// Unity Editor State representation
export interface UnityEditorState {
  activeGameObjects: string[];
  selectedObjects: string[];
  playModeState: string;
  sceneHierarchy: any;
  projectStructure: {
    [key: string]: string[];
  };
}

// Log entry from Unity
export interface LogEntry {
  message: string;
  stackTrace: string;
  logType: string;
  timestamp: string;
}

// Message types from Unity to Server
export interface EditorStateMessage {
  type: 'editorState';
  data: UnityEditorState;
}

export interface CommandResultMessage {
  type: 'commandResult';
  data: any;
}

export interface LogMessage {
  type: 'log';
  data: LogEntry;
}

export interface PongMessage {
  type: 'pong';
  data: { timestamp: number };
}

// Message types from Server to Unity
export interface ExecuteEditorCommandMessage {
  type: 'executeEditorCommand';
  data: {
    code: string;
  };
}

export interface HandshakeMessage {
  type: 'handshake';
  data: { message: string };
}

export interface PingMessage {
  type: 'ping';
  data: { timestamp: number };
}

export interface RequestEditorStateMessage {
  type: 'requestEditorState';
  data: Record<string, never>;
}

// Union type for all Unity messages
export type UnityMessage = 
  | EditorStateMessage 
  | CommandResultMessage 
  | LogMessage
  | PongMessage;

// Union type for all Server messages
export type ServerMessage =
  | ExecuteEditorCommandMessage
  | HandshakeMessage
  | PingMessage
  | RequestEditorStateMessage;

// Command result handling
export interface CommandPromise {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
}