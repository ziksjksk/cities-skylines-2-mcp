# Shared planning source

The executable TypeScript source currently lives in [`../mcp-server/src/`](../mcp-server/src/). The pure geometry module is [`../mcp-server/src/geometry.ts`](../mcp-server/src/geometry.ts), and the MCP orchestration layer is [`../mcp-server/src/autonomy.ts`](../mcp-server/src/autonomy.ts).

This directory is kept as the stable top-level source boundary for future shared planning modules. Do not copy game-specific C# code here: all Unity/ECS access belongs in [`../CS2MCP.Bridge/`](../CS2MCP.Bridge/).
