import { log } from '../../utils/logger.js?v=0206';

// ==========================================
// MCP 宸ュ叿绠＄悊閫昏緫
// ==========================================

// 鍏ㄥ眬鍙橀噺
let mcpTools = [];
let mcpEditingIndex = null;
let mcpProperties = [];
let websocket = null; // 灏嗕粠澶栭儴璁剧疆

/**
 * 璁剧疆 WebSocket 瀹炰緥
 * @param {WebSocket} ws - WebSocket 杩炴帴瀹炰緥
 */
export function setWebSocket(ws) {
    websocket = ws;
}

/**
 * 鍒濆鍖?MCP 宸ュ叿
 */
export async function initMcpTools() {
    // 鍔犺浇榛樿宸ュ叿鏁版嵁
    const defaultMcpTools = await fetch("js/config/default-mcp-tools.json").then(res => res.json());
    const savedTools = localStorage.getItem('mcpTools');
    if (savedTools) {
        try {
            const parsedTools = JSON.parse(savedTools);
            // 鍚堝苟榛樿宸ュ叿鍜岀敤鎴蜂繚瀛樼殑宸ュ叿锛屼繚鐣欑敤鎴疯嚜瀹氫箟鐨勫伐鍏?
            const defaultToolNames = new Set(defaultMcpTools.map(t => t.name));
            // 娣诲姞榛樿宸ュ叿涓笉瀛樺湪鐨勬柊宸ュ叿
            parsedTools.forEach(tool => {
                if (!defaultToolNames.has(tool.name)) {
                    defaultMcpTools.push(tool);
                }
            });
            mcpTools = defaultMcpTools;
        } catch (e) {
            log('鍔犺浇MCP宸ュ叿澶辫触锛屼娇鐢ㄩ粯璁ゅ伐鍏?, 'warning');
            mcpTools = [...defaultMcpTools];
        }
    } else {
        mcpTools = [...defaultMcpTools];
    }
    renderMcpTools();
    setupMcpEventListeners();
}

/**
 * 娓叉煋宸ュ叿鍒楄〃
 */
function renderMcpTools() {
    const container = document.getElementById('mcpToolsContainer');
    const countSpan = document.getElementById('mcpToolsCount');
    if (!container) {
        return; // Container not found, skip rendering
    }
    if (countSpan) {
        countSpan.textContent = `${mcpTools.length} 涓伐鍏穈;
    }
    if (mcpTools.length === 0) {
        container.innerHTML = '<div style="text-align: center; padding: 30px; color: #999;">鏆傛棤宸ュ叿锛岀偣鍑讳笅鏂规寜閽坊鍔犳柊宸ュ叿</div>';
        return;
    }
    container.innerHTML = mcpTools.map((tool, index) => {
        const paramCount = tool.inputSchema.properties ? Object.keys(tool.inputSchema.properties).length : 0;
        const requiredCount = tool.inputSchema.required ? tool.inputSchema.required.length : 0;
        const hasMockResponse = tool.mockResponse && Object.keys(tool.mockResponse).length > 0;
        return `
            <div class="mcp-tool-card">
                <div class="mcp-tool-header">
                    <div class="mcp-tool-name">${tool.name}</div>
                    <div class="mcp-tool-actions">
                        <button class="mcp-edit-btn" onclick="window.mcpModule.editMcpTool(${index})">
                            鉁忥笍 缂栬緫
                        </button>
                        <button class="mcp-delete-btn" onclick="window.mcpModule.deleteMcpTool(${index})">
                            馃棏锔?鍒犻櫎
                        </button>
                    </div>
                </div>
                <div class="mcp-tool-description">${tool.description}</div>
                <div class="mcp-tool-info">
                    <div class="mcp-tool-info-row">
                        <span class="mcp-tool-info-label">鍙傛暟鏁伴噺:</span>
                        <span class="mcp-tool-info-value">${paramCount} 涓?${requiredCount > 0 ? `(${requiredCount} 涓繀濉?` : ''}</span>
                    </div>
                    <div class="mcp-tool-info-row">
                        <span class="mcp-tool-info-label">妯℃嫙杩斿洖:</span>
                        <span class="mcp-tool-info-value">${hasMockResponse ? '鉁?宸查厤缃? ' + JSON.stringify(tool.mockResponse) : '鈿?浣跨敤榛樿'}</span>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

/**
 * 娓叉煋鍙傛暟鍒楄〃
 */
function renderMcpProperties() {
    const container = document.getElementById('mcpPropertiesContainer');
    const emptyState = document.getElementById('mcpEmptyState');
    if (!container) {
        return; // Container not found, skip rendering
    }
    if (mcpProperties.length === 0) {
        if (emptyState) {
            emptyState.style.display = 'block';
        }
        container.innerHTML = '';
        return;
    }
    if (emptyState) {
        emptyState.style.display = 'none';
    }
    container.innerHTML = mcpProperties.map((prop, index) => `
        <div class="mcp-property-card" onclick="window.mcpModule.editMcpProperty(${index})">
            <div class="mcp-property-row-label">
                <span class="mcp-property-label">鍙傛暟鍚嶇О</span>
                <span class="mcp-property-value">${prop.name}${prop.required ? ' <span class="mcp-property-required-badge">[蹇呭～]</span>' : ''}</span>
            </div>
            <div class="mcp-property-row-label">
                <span class="mcp-property-label">鏁版嵁绫诲瀷</span>
                <span class="mcp-property-value">${getTypeLabel(prop.type)}</span>
            </div>
            <div class="mcp-property-row-label">
                <span class="mcp-property-label">鎻忚堪</span>
                <span class="mcp-property-value">${prop.description || '-'}</span>
            </div>
            <div class="mcp-property-row-action">
                <button class="mcp-property-delete-btn" onclick="event.stopPropagation(); window.mcpModule.deleteMcpProperty(${index})">鍒犻櫎</button>
            </div>
        </div>
    `).join('');
}

/**
 * 鑾峰彇鏁版嵁绫诲瀷鏍囩
 */
function getTypeLabel(type) {
    const typeMap = {
        'string': '瀛楃涓?,
        'integer': '鏁存暟',
        'number': '鏁板瓧',
        'boolean': '甯冨皵鍊?,
        'array': '鏁扮粍',
        'object': '瀵硅薄'
    };
    return typeMap[type] || type;
}

/**
 * 娣诲姞鍙傛暟 - 鎵撳紑鍙傛暟缂栬緫妯℃€佹
 */
function addMcpProperty() {
    openPropertyModal();
}

/**
 * 缂栬緫鍙傛暟 - 鎵撳紑鍙傛暟缂栬緫妯℃€佹
 */
function editMcpProperty(index) {
    openPropertyModal(index);
}

/**
 * 鎵撳紑鍙傛暟缂栬緫妯℃€佹
 */
function openPropertyModal(index = null) {
    const form = document.getElementById('mcpPropertyForm');
    const title = document.getElementById('mcpPropertyModalTitle');
    document.getElementById('mcpPropertyIndex').value = index !== null ? index : -1;

    if (index !== null) {
        const prop = mcpProperties[index];
        title.textContent = '缂栬緫鍙傛暟';
        document.getElementById('mcpPropertyName').value = prop.name;
        document.getElementById('mcpPropertyType').value = prop.type || 'string';
        document.getElementById('mcpPropertyMinimum').value = prop.minimum !== undefined ? prop.minimum : '';
        document.getElementById('mcpPropertyMaximum').value = prop.maximum !== undefined ? prop.maximum : '';
        document.getElementById('mcpPropertyDescription').value = prop.description || '';
        document.getElementById('mcpPropertyRequired').checked = prop.required || false;
    } else {
        title.textContent = '娣诲姞鍙傛暟';
        form.reset();
        document.getElementById('mcpPropertyName').value = `param_${mcpProperties.length + 1}`;
        document.getElementById('mcpPropertyType').value = 'string';
        document.getElementById('mcpPropertyMinimum').value = '';
        document.getElementById('mcpPropertyMaximum').value = '';
        document.getElementById('mcpPropertyDescription').value = '';
        document.getElementById('mcpPropertyRequired').checked = false;
    }

    updatePropertyRangeVisibility();
    document.getElementById('mcpPropertyModal').style.display = 'flex';
}

/**
 * 鍏抽棴鍙傛暟缂栬緫妯℃€佹
 */
function closePropertyModal() {
    document.getElementById('mcpPropertyModal').style.display = 'none';
}

/**
 * 鏇存柊鏁板€艰寖鍥磋緭鍏ユ鐨勫彲瑙佹€?
 */
function updatePropertyRangeVisibility() {
    const type = document.getElementById('mcpPropertyType').value;
    const rangeGroup = document.getElementById('mcpPropertyRangeGroup');
    if (type === 'integer' || type === 'number') {
        rangeGroup.style.display = 'block';
    } else {
        rangeGroup.style.display = 'none';
    }
}

/**
 * 澶勭悊鍙傛暟琛ㄥ崟鎻愪氦
 */
function handlePropertySubmit(e) {
    e.preventDefault();
    const index = parseInt(document.getElementById('mcpPropertyIndex').value);
    const name = document.getElementById('mcpPropertyName').value.trim();
    const type = document.getElementById('mcpPropertyType').value;
    const minimum = document.getElementById('mcpPropertyMinimum').value;
    const maximum = document.getElementById('mcpPropertyMaximum').value;
    const description = document.getElementById('mcpPropertyDescription').value.trim();
    const required = document.getElementById('mcpPropertyRequired').checked;

    // 妫€鏌ュ悕绉伴噸澶?
    const isDuplicate = mcpProperties.some((p, i) => i !== index && p.name === name);
    if (isDuplicate) {
        alert('鍙傛暟鍚嶇О宸插瓨鍦紝璇蜂娇鐢ㄤ笉鍚岀殑鍚嶇О');
        return;
    }

    const propData = {
        name,
        type,
        description,
        required
    };

    // 鏁板€肩被鍨嬫坊鍔犺寖鍥撮檺鍒?
    if (type === 'integer' || type === 'number') {
        if (minimum !== '') {
            propData.minimum = parseFloat(minimum);
        }
        if (maximum !== '') {
            propData.maximum = parseFloat(maximum);
        }
    }

    if (index >= 0) {
        mcpProperties[index] = propData;
    } else {
        mcpProperties.push(propData);
    }

    renderMcpProperties();
    closePropertyModal();
}

/**
 * 鍒犻櫎鍙傛暟
 */
function deleteMcpProperty(index) {
    mcpProperties.splice(index, 1);
    renderMcpProperties();
}

/**
 * 璁剧疆浜嬩欢鐩戝惉
 */
function setupMcpEventListeners() {
    const panel = document.getElementById('mcpToolsPanel');
    const addBtn = document.getElementById('addMcpToolBtn');
    const modal = document.getElementById('mcpToolModal');
    const closeBtn = document.getElementById('closeMcpModalBtn');
    const cancelBtn = document.getElementById('cancelMcpBtn');
    const form = document.getElementById('mcpToolForm');
    const addPropertyBtn = document.getElementById('addMcpPropertyBtn');

    // 鍙傛暟缂栬緫妯℃€佹鐩稿叧鍏冪礌
    const propertyModal = document.getElementById('mcpPropertyModal');
    const closePropertyBtn = document.getElementById('closeMcpPropertyModalBtn');
    const cancelPropertyBtn = document.getElementById('cancelMcpPropertyBtn');
    const propertyForm = document.getElementById('mcpPropertyForm');
    const propertyTypeSelect = document.getElementById('mcpPropertyType');

    // Return early if required elements don't exist (e.g., in test environment)
    if (!panel || !addBtn || !modal || !closeBtn || !cancelBtn || !form || !addPropertyBtn) {
        return;
    }
    addBtn.addEventListener('click', () => openMcpModal());
    closeBtn.addEventListener('click', closeMcpModal);
    cancelBtn.addEventListener('click', closeMcpModal);
    addPropertyBtn.addEventListener('click', addMcpProperty);
    form.addEventListener('submit', handleMcpSubmit);

    // 鍙傛暟缂栬緫妯℃€佹浜嬩欢
    if (propertyModal && closePropertyBtn && cancelPropertyBtn && propertyForm && propertyTypeSelect) {
        closePropertyBtn.addEventListener('click', closePropertyModal);
        cancelPropertyBtn.addEventListener('click', closePropertyModal);
        propertyForm.addEventListener('submit', handlePropertySubmit);
        propertyTypeSelect.addEventListener('change', updatePropertyRangeVisibility);
    }
}

/**
 * 鎵撳紑妯℃€佹
 */
function openMcpModal(index = null) {
    const isConnected = websocket && websocket.readyState === WebSocket.OPEN;
    if (isConnected) {
        alert('WebSocket 宸茶繛鎺ワ紝鏃犳硶缂栬緫宸ュ叿');
        return;
    }
    mcpEditingIndex = index;
    const errorContainer = document.getElementById('mcpErrorContainer');
    errorContainer.innerHTML = '';
    if (index !== null) {
        document.getElementById('mcpModalTitle').textContent = '缂栬緫宸ュ叿';
        const tool = mcpTools[index];
        document.getElementById('mcpToolName').value = tool.name;
        document.getElementById('mcpToolDescription').value = tool.description;
        document.getElementById('mcpMockResponse').value = tool.mockResponse ? JSON.stringify(tool.mockResponse, null, 2) : '';
        mcpProperties = [];
        const schema = tool.inputSchema;
        if (schema.properties) {
            Object.keys(schema.properties).forEach(key => {
                const prop = schema.properties[key];
                mcpProperties.push({
                    name: key,
                    type: prop.type || 'string',
                    minimum: prop.minimum,
                    maximum: prop.maximum,
                    description: prop.description || '',
                    required: schema.required && schema.required.includes(key)
                });
            });
        }
    } else {
        document.getElementById('mcpModalTitle').textContent = '娣诲姞宸ュ叿';
        document.getElementById('mcpToolForm').reset();
        mcpProperties = [];
    }
    renderMcpProperties();
    document.getElementById('mcpToolModal').style.display = 'flex';
}

/**
 * 鍏抽棴妯℃€佹
 */
function closeMcpModal() {
    document.getElementById('mcpToolModal').style.display = 'none';
    mcpEditingIndex = null;
    document.getElementById('mcpToolForm').reset();
    mcpProperties = [];
    document.getElementById('mcpErrorContainer').innerHTML = '';
}

/**
 * 澶勭悊琛ㄥ崟鎻愪氦
 */
function handleMcpSubmit(e) {
    e.preventDefault();
    const errorContainer = document.getElementById('mcpErrorContainer');
    errorContainer.innerHTML = '';
    const name = document.getElementById('mcpToolName').value.trim();
    const description = document.getElementById('mcpToolDescription').value.trim();
    const mockResponseText = document.getElementById('mcpMockResponse').value.trim();
    // 妫€鏌ュ悕绉伴噸澶?
    const isDuplicate = mcpTools.some((tool, index) => tool.name === name && index !== mcpEditingIndex);
    if (isDuplicate) {
        showMcpError('宸ュ叿鍚嶇О宸插瓨鍦紝璇蜂娇鐢ㄤ笉鍚岀殑鍚嶇О');
        return;
    }
    // 瑙ｆ瀽妯℃嫙杩斿洖缁撴灉
    let mockResponse = null;
    if (mockResponseText) {
        try {
            mockResponse = JSON.parse(mockResponseText);
        } catch (e) {
            showMcpError('妯℃嫙杩斿洖缁撴灉涓嶆槸鏈夋晥鐨?JSON 鏍煎紡: ' + e.message);
            return;
        }
    }
    // 鏋勫缓 inputSchema
    const inputSchema = { type: "object", properties: {}, required: [] };
    mcpProperties.forEach(prop => {
        const propSchema = { type: prop.type };
        if (prop.description) {
            propSchema.description = prop.description;
        }
        if ((prop.type === 'integer' || prop.type === 'number')) {
            if (prop.minimum !== undefined && prop.minimum !== '') {
                propSchema.minimum = prop.minimum;
            }
            if (prop.maximum !== undefined && prop.maximum !== '') {
                propSchema.maximum = prop.maximum;
            }
        }
        inputSchema.properties[prop.name] = propSchema;
        if (prop.required) {
            inputSchema.required.push(prop.name);
        }
    });
    if (inputSchema.required.length === 0) {
        delete inputSchema.required;
    }
    const tool = { name, description, inputSchema, mockResponse };
    if (mcpEditingIndex !== null) {
        mcpTools[mcpEditingIndex] = tool;
        log(`宸叉洿鏂板伐鍏? ${name}`, 'success');
    } else {
        mcpTools.push(tool);
        log(`宸叉坊鍔犲伐鍏? ${name}`, 'success');
    }
    saveMcpTools();
    renderMcpTools();
    closeMcpModal();
}

/**
 * 鏄剧ず閿欒
 */
function showMcpError(message) {
    const errorContainer = document.getElementById('mcpErrorContainer');
    errorContainer.innerHTML = `<div class="mcp-error">${message}</div>`;
}

/**
 * 缂栬緫宸ュ叿
 */
function editMcpTool(index) {
    openMcpModal(index);
}

/**
 * 鍒犻櫎宸ュ叿
 */
function deleteMcpTool(index) {
    const isConnected = websocket && websocket.readyState === WebSocket.OPEN;
    if (isConnected) {
        alert('WebSocket 宸茶繛鎺ワ紝鏃犳硶缂栬緫宸ュ叿');
        return;
    }
    if (confirm(`纭畾瑕佸垹闄ゅ伐鍏?"${mcpTools[index].name}" 鍚楋紵`)) {
        const toolName = mcpTools[index].name;
        mcpTools.splice(index, 1);
        saveMcpTools();
        renderMcpTools();
        log(`宸插垹闄ゅ伐鍏? ${toolName}`, 'info');
    }
}

/**
 * 淇濆瓨宸ュ叿
 */
function saveMcpTools() {
    localStorage.setItem('mcpTools', JSON.stringify(mcpTools));
}

/**
 * 鑾峰彇宸ュ叿鍒楄〃
 */
export function getMcpTools() {
    return mcpTools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
}

/**
 * 鎵ц宸ュ叿璋冪敤
 */
export async function executeMcpTool(toolName, toolArgs) {
    const tool = mcpTools.find(t => t.name === toolName);
    if (!tool) {
        log(`鏈壘鍒板伐鍏? ${toolName}`, 'error');
        return { success: false, error: `鏈煡宸ュ叿: ${toolName}` };
    }

    // 澶勭悊鎷嶇収宸ュ叿
    if (toolName === 'self_camera_take_photo') {
        if (typeof window.takePhoto === 'function') {
            const question = toolArgs && toolArgs.question ? toolArgs.question : '鎻忚堪涓€涓嬬湅鍒扮殑鐗╁搧';
            log(`姝ｅ湪鎵ц鎷嶇収: ${question}`, 'info');
            const result = await window.takePhoto(question);
            return result;
        } else {
            log('鎷嶇収鍔熻兘涓嶅彲鐢?, 'warning');
            return { success: false, error: '鎽勫儚澶存湭鍚姩鎴栦笉鏀寔鎷嶇収鍔熻兘' };
        }
    }

    // 棰勭暀褰曞儚宸ュ叿锛氬綍鍒朵竴娈佃棰戝苟涓婁紶锛堜緵绾伐鍏疯Е鍙戞ā寮忓鐢紝鏈湡涓婚摼璺蛋VAD鑷姩瑙﹀彂锛?
    if (toolName === 'self_camera_record_video') {
        if (typeof window.recordVideo !== 'function') {
            log('褰曞儚鍔熻兘涓嶅彲鐢?, 'warning');
            return { success: false, error: '鎽勫儚澶存湭鍚姩鎴栨祻瑙堝櫒涓嶆敮鎸佸綍鍍? };
        }
        const requestId = (toolArgs && toolArgs.request_id) ||
            ('tool_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
        const maxDurationMs = (toolArgs && toolArgs.duration_ms) || 5000;
        log(`姝ｅ湪鎵ц褰曞儚: ${requestId}, 鏈€闀?{maxDurationMs}ms`, 'info');
        const blob = await window.recordVideo({ requestId, maxDurationMs });
        if (!blob) {
            return { success: false, error: '褰曞儚澶辫触鎴栨椂闀胯繃鐭? };
        }
        if (typeof window.uploadVideoBlob === 'function') {
            const uploadResult = await window.uploadVideoBlob(blob, requestId);
            return { success: uploadResult.success, message: '褰曞儚宸蹭笂浼?, request_id: requestId, upload: uploadResult };
        }
        return { success: true, message: '褰曞儚瀹屾垚(鏈厤缃笂浼?', request_id: requestId };
    }

    // 濡傛灉鏈夋ā鎷熻繑鍥炵粨鏋滐紝浣跨敤瀹?
    if (tool.mockResponse) {
        // 鏇挎崲妯℃澘鍙橀噺
        let responseStr = JSON.stringify(tool.mockResponse);
        // 鏇挎崲 ${paramName} 鏍煎紡鐨勫彉閲?
        if (toolArgs) {
            Object.keys(toolArgs).forEach(key => {
                const regex = new RegExp(`\\$\\{${key}\\}`, 'g');
                responseStr = responseStr.replace(regex, toolArgs[key]);
            });
        }
        try {
            const response = JSON.parse(responseStr);
            log(`宸ュ叿 ${toolName} 鎵ц鎴愬姛锛岃繑鍥炴ā鎷熺粨鏋? ${responseStr}`, 'success');
            return response;
        } catch (e) {
            log(`瑙ｆ瀽妯℃嫙杩斿洖缁撴灉澶辫触: ${e.message}`, 'error');
            return tool.mockResponse;
        }
    }
    // 娌℃湁妯℃嫙杩斿洖缁撴灉锛岃繑鍥為粯璁ゆ垚鍔熸秷鎭?
    log(`宸ュ叿 ${toolName} 鎵ц鎴愬姛锛岃繑鍥為粯璁ょ粨鏋渀, 'success');
    return { success: true, message: `宸ュ叿 ${toolName} 鎵ц鎴愬姛`, tool: toolName, arguments: toolArgs };
}

// 鏆撮湶鍏ㄥ眬鏂规硶渚?HTML 鍐呰仈浜嬩欢璋冪敤
window.mcpModule = { addMcpProperty, editMcpProperty, deleteMcpProperty, editMcpTool, deleteMcpTool };
