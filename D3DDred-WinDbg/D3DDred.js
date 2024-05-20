// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

"use strict";

const AutoBreadcrumbsBufferSizeInBytes = 65536;
const AutoBreadcrumbsCommandHistoryOffset = 4096;
const AutoBreadcrumbsCommandHistoryMax = (AutoBreadcrumbsBufferSizeInBytes - AutoBreadcrumbsCommandHistoryOffset) / 4;

var opStrings = {};

function getEnumString(val, enumType)
{
    var keys = Object.keys(opStrings);
    if (keys.length == 0)
    {
        // Build the opStrings dictionary
        for (var enumerantName of Object.getOwnPropertyNames(enumType.fields))
        {
            var enumerant = enumType.fields[enumerantName];
            opStrings[enumerant.value] = enumerantName;
        }
    }

    var key = val.value;
    if (opStrings.hasOwnProperty(key))
    {
        return opStrings[key];
    }

    return "Unknown";
}

function getContextTable(node)
{
    var contextTable = {};

    // Create a dictionary of breadcrumb contexts keyed by the breadcrumb index
    for(var i = 0; i < node.BreadcrumbContextsCount; ++i)
    {
        contextTable[node.pBreadcrumbContexts[i].BreadcrumbIndex] = i;
    }

    return contextTable;
}

function initializeScript()
{
    var symbolSource = "";

    class BreadcrumbOp
    {
        constructor(op, context)
        {
            this.__op = op;
            this.__context = context;
        }

        toString()
        {
            var opName = getEnumString(this.__op, host.getModuleType(symbolSource, "D3D12_AUTO_BREADCRUMB_OP"));
            return opName + (this.__context ? ", Name: " + host.memory.readWideString(this.__context) : "");
        }

        get Op() { return this.__op;}
        get Context() { return this.__context;}
    }

    // Produces an array from completed breadcrumb operations
    class CompletedOps
    {
        constructor(node)
        {
            this.__node = node;
            this.__numCompletedOps = node.pLastBreadcrumbValue.dereference();
            this.__numOps = node.BreadcrumbCount;
        }

        toString()
        {
            return "Count: " + this.__numCompletedOps;
        }

        *[Symbol.iterator]()
        {
            if(this.__numOps > AutoBreadcrumbsCommandHistoryMax)
            {
                host.diagnostics.debugLog("Number of command operations exceeds " + AutoBreadcrumbsCommandHistoryMax + ", the capacity of the AutoBreadcrumb command history")
                var totalDroppedCount = this.__numOps - AutoBreadcrumbsCommandHistoryMax;
                var completedDroppedCount = max(0, this.__numCompletedOps - totalDroppedCount);
                host.diagnostics.debugLog("Total commands dropped: " + totalDroppedCount);
                host.diagnostics.debugLog("Completed commands dropped: " + completedDroppedCount);
            }

            var contextTable = getContextTable(this.__node);

            // Iterate through each completed op and output the BreadcrumbOp
            for(var count = 0; count < this.__numCompletedOps && count < AutoBreadcrumbsCommandHistoryMax; count++)
            {
                var index = this.__numCompletedOps - count - 1;
                var op = host.typeSystem.marshalAs(this.__node.pCommandHistory[index], symbolSource, "D3D12_AUTO_BREADCRUMB_OP");
                
                var contextString = null;
                if(contextTable.hasOwnProperty(index))
                {
                    contextString = this.__node.pBreadcrumbContexts[contextTable[index]].pContextString;
                }
                yield new BreadcrumbOp(op, contextString);
            }
        }
    }

    // Produces an array from not-yet-completed breadcrumb operations
    class OutstandingOps
    {
        constructor(node)
        {
            this.__node = node;
            this.__numCompletedOps = node.pLastBreadcrumbValue.dereference();
            this.__numOps = node.BreadcrumbCount;
        }

        toString()
        {
            return "Count: " + (this.__numOps - this.__numCompletedOps);
        }

        *[Symbol.iterator]()
        {
            var outstanding = this.__numOps - this.__numCompletedOps;
            var dropped = outstanding - AutoBreadcrumbsCommandHistoryMax;
            var remaining = outstanding - dropped;
            if( dropped > 0 )
            {
                host.diagnostics.debugLog("Only the last " + remaining + " of " + outstanding + " outstanding operations are available\n");
            }
            var start = Math.max(this.__numCompletedOps, this.__numOps - AutoBreadcrumbsCommandHistoryMax);

            var contextTable = getContextTable(this.__node);

            for(var opIndex = start; opIndex < this.__numOps; ++opIndex)
            {
                var index = opIndex % AutoBreadcrumbsCommandHistoryMax;
                var op = host.typeSystem.marshalAs(this.__node.pCommandHistory[index], symbolSource, "D3D12_AUTO_BREADCRUMB_OP");

                var contextString = null;
                if(contextTable.hasOwnProperty(index))
                {
                    contextString = this.__node.pBreadcrumbContexts[contextTable[index]].pContextString;
                }
                
                yield new BreadcrumbOp(op, contextString);
            }
        }
    }

    class BreadcrumbContexts
    {
        constructor(node)
        {
            this.__node = node;
            this.__contextCount = node.BreadcrumbContextsCount;
        }

        *[Symbol.iterator]()
        {
            for(var i = 0; i < this.__contextCount; ++i)
            {
                yield this.__node.pBreadcrumbContexts[i];
            }
        }
    }

    // Helper function for choosing wide vs narrow name string (prefer narrow)
    function SelectNameHelper(pNameA, pNameW)
    {
        // If the ascii name pointer is not null then select it
        if(pNameA.isNull)
        {
            return pNameW;
        }
        else
        {
            return pNameA;
        }
    }

    // Visualizer class for D3D12_AUTO_BREADCRUMB_NODE
    class AutoBreadcrumbNodeVis
    {
        get CommandListDebugName() { return SelectNameHelper(this.pCommandListDebugNameA, this.pCommandListDebugNameW);}
        get CommandQueueDebugName() { return SelectNameHelper(this.pCommandQueueDebugNameA, this.pCommandQueueDebugNameW);}
        get NumCompletedAutoBreadcrumbOps() { return this.pLastBreadcrumbValue.dereference(); }
        get NumAutoBreadcrumbOps() { return this.BreadcrumbCount; }
        get ReverseCompletedOps() { return new CompletedOps(this); }
        get OutstandingOps() { return new OutstandingOps(this); }
    }

    // Visualizer class for D3D12_AUTO_BREADCRUMB_NODE1
    class AutoBreadcrumbNode1Vis extends AutoBreadcrumbNodeVis
    {
        get BreadcrumbContexts() { return new BreadcrumbContexts(this); }
    }

    // Helper class for creating an array from linked list elements
    class LinkedDredNodesToArray
    {
        constructor(headNode)
        {
            const CreateArray = host.namespace.Debugger.Utility.Collections.CreateArray;
            if(!headNode.isNull)
            {
                var array = CreateArray(headNode).Flatten(function(node) 
                    { return node.pNext.isNull ? null : CreateArray(node.pNext); });            
                this.__nodes = array
            }
            else
            {
                this.__nodes = CreateArray();
            }
        }

        toString()
        {
            return "Count: " + this.__nodes.Count();
        }

        *[Symbol.iterator]()
        {
            for(var node of this.__nodes)
            {
                yield node;
            }
        }
    }

    // Visualizer class for D3D12_DEVICE_REMOVED_EXTENDED_DATA
    class DeviceRemovedExtendedDataVis
    {
        get AutoBreadcrumbNodes()
        {
            return new LinkedDredNodesToArray(this.pHeadAutoBreadcrumbNode);
        }
    }

    // Visualizer class for D3D12_DEVICE_REMOVED_EXTENDED_DATA1
    class DeviceRemovedExtendedData1Vis
    {
        get DeviceRemovedReason()
        {
            return host.typeSystem.marshalAs(this.DeviceRemovedReason, symbolSource, "HRESULT"); 
        }
        
        get AutoBreadcrumbNodes()
        {
            return new LinkedDredNodesToArray(this.AutoBreadcrumbsOutput.pHeadAutoBreadcrumbNode);
        }

        get PageFaultVA()
        {
            return this.PageFaultOutput.PageFaultVA;
        }

        get ExistingAllocations()
        {
            return new LinkedDredNodesToArray(this.PageFaultOutput.pHeadExistingAllocationNode);
        }

        get RecentFreedAllocations()
        {
            return new LinkedDredNodesToArray(this.PageFaultOutput.pHeadRecentFreedAllocationNode );
        }
    }

    // Visualizer class for D3D12_DEVICE_REMOVED_EXTENDED_DATA2
    class DeviceRemovedExtendedData2Vis
    {
        get DeviceRemovedReason()
        {
            return host.typeSystem.marshalAs(this.DeviceRemovedReason, symbolSource, "HRESULT");
        }
        
        get AutoBreadcrumbNodes()
        {
            return new LinkedDredNodesToArray(this.AutoBreadcrumbsOutput.pHeadAutoBreadcrumbNode);
        }

        get PageFaultVA()
        {
            return this.PageFaultOutput.PageFaultVA;
        }

        get ExistingAllocations()
        {
            return new LinkedDredNodesToArray(this.PageFaultOutput.pHeadExistingAllocationNode);
        }

        get RecentFreedAllocations()
        {
            return new LinkedDredNodesToArray(this.PageFaultOutput.pHeadRecentFreedAllocationNode );
        }
    }

    // Visualizer class for D3D12_DEVICE_REMOVED_EXTENDED_DATA3
    class DeviceRemovedExtendedData3Vis
    {
        get DeviceState()
        {
            return host.typeSystem.marshalAs(this.DeviceState, symbolSource, "D3D12_DRED_DEVICE_STATE");
        }

        get DeviceRemovedReason()
        {
            return host.typeSystem.marshalAs(this.DeviceRemovedReason, symbolSource, "HRESULT");
        }

        get AutoBreadcrumbNodes()
        {
            return new LinkedDredNodesToArray(this.AutoBreadcrumbsOutput.pHeadAutoBreadcrumbNode);
        }

        get PageFaultVA()
        {
            return this.PageFaultOutput.PageFaultVA;
        }

        get ExistingAllocations()
        {
            return new LinkedDredNodesToArray(this.PageFaultOutput.pHeadExistingAllocationNode);
        }

        get RecentFreedAllocations()
        {
            return new LinkedDredNodesToArray(this.PageFaultOutput.pHeadRecentFreedAllocationNode );
        }
    }

    // Visualizer class for D3D12_DRED_ALLOCATION_NODE
    class DredAllocationNodeVis
    {
        get ObjectName()
        {
            return SelectNameHelper(this.ObjectNameA, this.ObjectNameW);
        }

        get AllocationType()
        {
            return host.typeSystem.marshalAs(this.AllocationType, symbolSource, "D3D12_DRED_ALLOCATION_TYPE");
        }
    }

    // Visualizer class for D3D12_DRED_ALLOCATION_NODE1
    class DredAllocationNode1Vis extends DredAllocationNodeVis
    {
    }

    // Visualizer class for D3D12_VERSIONED_DEVICE_REMOVED_EXTENDED_DATA
    class VersionedDeviceRemovedExtendedDataVis
    {
        get DREDVersion() { return this["Version"]; }
        get Data()
        {
            switch(this["Version"])
            {
                case 1:
                return this.Dred_1_0;
                break;

                case 2:
                return this.Dred_1_1;
                break;

                case 3:
                return this.Dred_1_2;
                break;

                case 4:
                return this.Dred_1_3;
                break;

                default:
                return Error("Invalid or corrupt version data");
                break;
            }
        }
    }

    function __d3d12DeviceRemovedExtendedData()
    {
        // The D3D12 has been refactored into D3D12.dll and D3D12Core.dll.  On systems with this
        // refactoring, D3D12DeviceRemovedExtendedData is hosted in D3D12Core.dll.
        symbolSource = "d3d12core";
        var x = host.getModuleSymbolAddress(symbolSource, "D3D12DeviceRemovedExtendedData");
        
        if (x == null)
        {
            // Otherwise DRED data is located in d3d12.dll.
            symbolSource = "d3d12";
            x = host.getModuleSymbolAddress(symbolSource, "D3D12DeviceRemovedExtendedData");
        }

        // Need to cast the return type to D3D12_VERSIONED_DEVICE_REMOVED_EXTENDED_DATA
        // since this information is stripped out of the public PDB
        try
        {
            // First try using the D3D12_VERSIONED_DEVICE_REMOVED_EXTENDED_DATA symbol contained
            // in d3d12.pdb.  Legacy public d3d12 pdb's do not have this type information at all.
            var dred = host.createTypedObject(x, symbolSource, "D3D12_VERSIONED_DEVICE_REMOVED_EXTENDED_DATA");
            return dred.Data;
        }
        catch(err)
        {
            // host.namespace.Debugger.Sessions[0].Processes[0].Modules[0].Name
            // Iterate through the loaded modules attempt the cast.
            // Note: the first loaded module is the application .exe.  If the app
            // has the DRED symbols loaded then this should go quick.
            for(var m of host.currentProcess.Modules)
            {
                try
                {
                    symbolSource = m.Name;
                    var dred = host.createTypedObject(x, symbolSource, "D3D12_VERSIONED_DEVICE_REMOVED_EXTENDED_DATA");
                    return dred.Data;
                }
                catch(err)
                {
                    // Skip to the next one
                }
            }
        }
        
        // None of the symbols contain 
        host.diagnostics.debugLog("ERROR: D3D12_VERSIONED_DEVICE_REMOVED_EXTENDED_DATA not found in any loaded symbol files.\n")
        return null;
    }

    return [ new host.typeSignatureRegistration(VersionedDeviceRemovedExtendedDataVis, "D3D12_VERSIONED_DEVICE_REMOVED_EXTENDED_DATA"),
             new host.typeSignatureRegistration(DeviceRemovedExtendedDataVis, "D3D12_DEVICE_REMOVED_EXTENDED_DATA"),
             new host.typeSignatureRegistration(DeviceRemovedExtendedData1Vis, "D3D12_DEVICE_REMOVED_EXTENDED_DATA1"),
             new host.typeSignatureRegistration(DeviceRemovedExtendedData2Vis, "D3D12_DEVICE_REMOVED_EXTENDED_DATA2"),
             new host.typeSignatureRegistration(DeviceRemovedExtendedData3Vis, "D3D12_DEVICE_REMOVED_EXTENDED_DATA3"),
             new host.typeSignatureRegistration(AutoBreadcrumbNodeVis, "D3D12_AUTO_BREADCRUMB_NODE"),
             new host.typeSignatureRegistration(AutoBreadcrumbNode1Vis, "D3D12_AUTO_BREADCRUMB_NODE1"),
             new host.typeSignatureRegistration(DredAllocationNodeVis, "D3D12_DRED_ALLOCATION_NODE"),
             new host.typeSignatureRegistration(DredAllocationNode1Vis, "D3D12_DRED_ALLOCATION_NODE1"),
             new host.functionAlias(__d3d12DeviceRemovedExtendedData, "d3ddred")];
}

function uninitializeScript()
{
}
