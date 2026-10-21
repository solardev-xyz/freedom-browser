// Disposable CI research only, not the production sandbox. A dynamic WFP
// session removes all owned filters when this process exits, including crashes.
#include <windows.h>
#include <initguid.h>
#include <fwpmu.h>
#include <rpc.h>
#include <sddl.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <stdexcept>
#include <string>

static void checked(DWORD status, const char* operation) {
    if (status) {
        std::printf("%s failed: 0x%08lx\n", operation, status);
        throw std::runtime_error(operation);
    }
}

struct Engine {
    HANDLE handle = nullptr;
    ~Engine() { if (handle) FwpmEngineClose0(handle); }
};
struct Binding {
    RPC_BINDING_HANDLE handle = nullptr;
    ~Binding() { if (handle) RpcBindingFree(&handle); }
};
struct Interfaces {
    RPC_IF_ID_VECTOR* value = nullptr;
    ~Interfaces() { if (value) RpcIfIdVectorFree(&value); }
};
struct Descriptor {
    PSECURITY_DESCRIPTOR value = nullptr;
    ~Descriptor() { if (value) LocalFree(value); }
};

int wmain() {
    try {
        wchar_t github[8] = {};
        if (!GetEnvironmentVariableW(L"GITHUB_ACTIONS", github, 8) || wcscmp(github, L"true")) {
            throw std::runtime_error("Use only a disposable Windows CI runner");
        }
        Binding binding;
        checked(RpcBindingFromStringBindingW(reinterpret_cast<RPC_WSTR>(const_cast<wchar_t*>(L"ncalrpc:[DNSResolver]")),
            &binding.handle), "RpcBindingFromStringBindingW");
        checked(RpcMgmtSetComTimeout(binding.handle, 2), "RpcMgmtSetComTimeout");
        Interfaces interfaces;
        checked(RpcMgmtInqIfIds(binding.handle, &interfaces.value), "RpcMgmtInqIfIds");
        if (!interfaces.value->Count || interfaces.value->Count > 64) throw std::runtime_error("Unexpected interfaces");

        BYTE sid[SECURITY_MAX_SID_SIZE] = {};
        DWORD sid_size = sizeof(sid), domain_size = 256;
        wchar_t domain[256] = {};
        SID_NAME_USE use;
        if (!LookupAccountNameW(nullptr, L"FreedomSbxOffline", sid, &sid_size, domain, &domain_size, &use)) {
            checked(GetLastError(), "LookupAccountNameW");
        }
        LPWSTR sid_text = nullptr;
        if (!ConvertSidToStringSidW(sid, &sid_text)) checked(GetLastError(), "ConvertSidToStringSidW");
        const std::wstring sddl = std::wstring(L"D:(A;;CC;;;") + sid_text + L")";
        LocalFree(sid_text);
        Descriptor descriptor;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor.value, nullptr)) {
            checked(GetLastError(), "ConvertStringSecurityDescriptorToSecurityDescriptorW");
        }
        FWP_BYTE_BLOB user = { GetSecurityDescriptorLength(descriptor.value), static_cast<UINT8*>(descriptor.value) };

        // Succeeds only for a positively controlled completed workload that
        // reproduces the known leak, never for an unrelated fixture failure.
        if (_wsystem(L"node scripts/qualify-windows-dns.js --expect-existing-leak") != 0)
            throw std::runtime_error("Expected baseline leak absent");
        Engine engine;
        FWPM_SESSION0 session = {};
        session.flags = FWPM_SESSION_FLAG_DYNAMIC;
        checked(FwpmEngineOpen0(nullptr, RPC_C_AUTHN_DEFAULT, nullptr, &session, &engine.handle), "FwpmEngineOpen0");
        FWPM_SUBLAYER0 sublayer = {};
        checked(UuidCreate(&sublayer.subLayerKey), "UuidCreate(sublayer)");
        sublayer.displayData.name = const_cast<wchar_t*>(L"Freedom owned DNS RPC probe");
        sublayer.weight = 0xffff;
        checked(FwpmSubLayerAdd0(engine.handle, &sublayer, nullptr), "FwpmSubLayerAdd0");
        unsigned installed = 0;
        // Observed on both CI versions. Do not block the separate NRP/policy
        // interface: disabling policy could invalidate the NRPT test route.
        const UUID resolver = {0x45776b01,0x5956,0x4485,{0x9f,0x80,0xf4,0x28,0xf7,0xd6,0x01,0x29}};
        for (unsigned i = 0; i < interfaces.value->Count; i++) {
            const RPC_IF_ID& entry = *interfaces.value->IfId[i];
            if (std::memcmp(&entry.Uuid, &resolver, sizeof(UUID))) continue;
            RPC_CSTR uuid = nullptr;
            checked(UuidToStringA(&entry.Uuid, &uuid), "UuidToStringA");
            std::printf("Observed DNS interface %s v%u.%u\n", reinterpret_cast<char*>(uuid),
                static_cast<unsigned>(entry.VersMajor), static_cast<unsigned>(entry.VersMinor));
            RpcStringFreeA(&uuid);
            if (entry.VersMinor) throw std::runtime_error("Unqualified minor-version encoding");

            FWP_BYTE_ARRAY16 uuid_bytes = {};
            std::memcpy(uuid_bytes.byteArray16, &entry.Uuid, sizeof(UUID));
            FWPM_FILTER_CONDITION0 conditions[4] = {};
            for (auto& condition : conditions) condition.matchType = FWP_MATCH_EQUAL;
            conditions[0].fieldKey = FWPM_CONDITION_REMOTE_USER_TOKEN;
            conditions[0].conditionValue.type = FWP_SECURITY_DESCRIPTOR_TYPE;
            conditions[0].conditionValue.sd = &user;
            conditions[1].fieldKey = FWPM_CONDITION_RPC_IF_UUID;
            conditions[1].conditionValue.type = FWP_BYTE_ARRAY16_TYPE;
            conditions[1].conditionValue.byteArray16 = &uuid_bytes;
            conditions[2].fieldKey = FWPM_CONDITION_RPC_IF_VERSION;
            conditions[2].conditionValue.type = FWP_UINT16;
            conditions[2].conditionValue.uint16 = entry.VersMajor;
            conditions[3].fieldKey = FWPM_CONDITION_RPC_PROTOCOL;
            conditions[3].conditionValue.type = FWP_UINT8;
            conditions[3].conditionValue.uint8 = 3; // RPC_PROTSEQ_LRPC, Windows SDK rpcdcep.h.
            FWPM_FILTER0 filter = {};
            checked(UuidCreate(&filter.filterKey), "UuidCreate");
            filter.displayData.name = const_cast<wchar_t*>(L"Freedom owned DNS RPC probe");
            filter.layerKey = FWPM_LAYER_RPC_UM;
            filter.subLayerKey = sublayer.subLayerKey;
            filter.action.type = FWP_ACTION_BLOCK;
            filter.numFilterConditions = 4;
            filter.filterCondition = conditions;
            UINT64 id = 0;
            checked(FwpmFilterAdd0(engine.handle, &filter, nullptr, &id), "FwpmFilterAdd0(DNS RPC)");
            FWPM_FILTER0* actual = nullptr;
            checked(FwpmFilterGetById0(engine.handle, id, &actual), "FwpmFilterGetById0");
            bool matches = actual->numFilterConditions == 4 && actual->action.type == FWP_ACTION_BLOCK &&
                IsEqualGUID(actual->layerKey, FWPM_LAYER_RPC_UM) &&
                IsEqualGUID(actual->subLayerKey, sublayer.subLayerKey);
            // WFP may reorder conditions. Verify every typed field survived.
            for (const auto& expected : conditions) {
                bool found = false;
                for (UINT32 j = 0; j < actual->numFilterConditions; j++) {
                    const auto& got = actual->filterCondition[j];
                    if (!IsEqualGUID(got.fieldKey, expected.fieldKey) || got.matchType != FWP_MATCH_EQUAL ||
                        got.conditionValue.type != expected.conditionValue.type) continue;
                    if (IsEqualGUID(got.fieldKey, FWPM_CONDITION_REMOTE_USER_TOKEN))
                        found = got.conditionValue.sd->size == user.size && !std::memcmp(got.conditionValue.sd->data, user.data, user.size);
                    else if (IsEqualGUID(got.fieldKey, FWPM_CONDITION_RPC_IF_UUID))
                        found = !std::memcmp(got.conditionValue.byteArray16, &uuid_bytes, sizeof(uuid_bytes));
                    else if (IsEqualGUID(got.fieldKey, FWPM_CONDITION_RPC_IF_VERSION))
                        found = got.conditionValue.uint16 == entry.VersMajor;
                    else found = got.conditionValue.uint8 == 3;
                }
                matches = matches && found;
            }
            FwpmFreeMemory0(reinterpret_cast<void**>(&actual));
            if (!matches) throw std::runtime_error("Installed filter differs from requested boundary");
            installed++;
            std::printf("Verified DNS filter %llu: offline SID + observed interface/version + local RPC\n", id);
        }
        if (!installed) throw std::runtime_error("No DNS-specific interfaces found");
        const int result = _wsystem(L"node scripts/qualify-windows-dns.js");
        std::printf("Targeted RPC probe exit: %d; dynamic session now closes\n", result);
        return result == 0 ? 0 : 1;
    } catch (const std::exception& error) {
        std::printf("DNS RPC probe failed: %s\n", error.what());
        return 1;
    }
}
