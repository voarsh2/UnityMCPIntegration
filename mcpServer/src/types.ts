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

// Scene info from Unity
export interface SceneInfoMessage {
  type: 'sceneInfo';
  data: {
    requestId: string;
    sceneInfo: any;
    timestamp: string;
  };
}

// Game objects details from Unity
export interface GameObjectsDetailsMessage {
  type: 'gameObjectsDetails';
  data: {
    requestId: string;
    gameObjectDetails: any[];
    count: number;
    timestamp: string;
  };
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

export interface HeartbeatMessage {
  type: 'heartbeat';
  data: { timestamp: number };
}

export interface RequestEditorStateMessage {
  type: 'requestEditorState';
  data: Record<string, never>;
}

export interface GetSceneInfoMessage {
  type: 'getSceneInfo';
  data: {
    requestId: string;
    detailLevel: string;
  };
}

export interface GetGameObjectsInfoMessage {
  type: 'getGameObjectsInfo';
  data: {
    requestId: string;
    instanceIDs: number[];
    detailLevel: string;
  };
}

// Union type for all Unity messages
export type UnityMessage = 
  | EditorStateMessage 
  | CommandResultMessage 
  | LogMessage
  | PongMessage
  | SceneInfoMessage
  | GameObjectsDetailsMessage;

// Union type for all Server messages
export type ServerMessage =
  | ExecuteEditorCommandMessage
  | HandshakeMessage
  | HeartbeatMessage
  | RequestEditorStateMessage
  | GetSceneInfoMessage
  | GetGameObjectsInfoMessage;

// Command result handling
export interface CommandPromise {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
}