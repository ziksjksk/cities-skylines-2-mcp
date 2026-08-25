# Bridge source boundary

The in-game bridge project is [`../CS2MCP.Bridge/CS2MCP.Bridge.csproj`](../CS2MCP.Bridge/CS2MCP.Bridge.csproj). It is a .NET Framework 4.7.2 code mod compiled against the installed Cities: Skylines II Managed assemblies.

The bridge owns the localhost HTTP listener, main-thread queue, ECS perception, native construction pipeline, capability contract, and deployment to the local CS2 Mods directory. Keep Unity/ECS calls out of the Node MCP process.
