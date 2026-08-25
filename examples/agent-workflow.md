# Safe autonomous workflow example

This is a tool-order example, not a claim that a city has already been built.

```text
1. cs2_ping()
2. cs2_capabilities()
3. cs2_coordinate_info()
4. cs2_analyze_map({resolution:64})
5. cs2_discover_assets({category:"all",page:0,pageSize:100})
6. cs2_plan_metropolis({density:"high",fetchTerrain:true})
7. cs2_plan_road_network({start:{x:-1200,z:0},end:{x:1200,z:300},geometry:"bezier"})
8. cs2_build_interchange({center:{x:0,z:0},type:"diamond",elevatedCrossing:8,preview:true})
9. cs2_execute_master_plan({plan:the JSON returned by step 6,execute:false})
10. Review plan issues, limitations, and discovered prefab names.
11. cs2_execute_master_plan({plan:the reviewed JSON from step 9,execute:true,maxSegments:12,resume:false})
12. cs2_validate_city({includeScreenshots:true})
13. cs2_run_simulation({hours:6,speed:4})
14. cs2_analyze_city({terrainResolution:32})
15. Repeat one repair/expansion phase at a time.
```

If a capability is false, keep that phase as a plan and record why. If a native operation fails, stop, preserve its error, inspect the partial result, and do not assume rollback.
