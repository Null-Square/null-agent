const normalizeSourceLineEndings = (value)=>value.replace(/\r\n?/gu, '\n');
export const resolveCodeReviewSourceAnchor = (content, location)=>{
    const normalizedContent = normalizeSourceLineEndings(content);
    const normalizedAnchor = normalizeSourceLineEndings(location.sourceAnchor);
    const matchOffsets = [];
    let searchOffset = 0;
    while(searchOffset <= normalizedContent.length - normalizedAnchor.length){
        const matchOffset = normalizedContent.indexOf(normalizedAnchor, searchOffset);
        if (matchOffset < 0) break;
        matchOffsets.push(matchOffset);
        searchOffset = matchOffset + Math.max(1, normalizedAnchor.length);
    }
    if (matchOffsets.length === 0) {
        throw new Error(`${location.filePath}: sourceAnchor was not found in the immutable file`);
    }
    if (location.occurrence === undefined && matchOffsets.length > 1) {
        throw new Error(`${location.filePath}: sourceAnchor matched ${matchOffsets.length} locations; provide the 1-based occurrence`);
    }
    const occurrence = location.occurrence ?? 1;
    const matchOffset = matchOffsets[occurrence - 1];
    if (matchOffset === undefined) {
        throw new Error(`${location.filePath}: sourceAnchor occurrence ${occurrence} exceeds ${matchOffsets.length} matches`);
    }
    const anchorStartLine = normalizedContent.slice(0, matchOffset).split('\n').length;
    const anchorEndLine = anchorStartLine + normalizedAnchor.split('\n').length - 1;
    const lines = normalizedContent.split('\n');
    const startLine = Math.max(1, anchorStartLine - location.contextBeforeLines);
    const endLine = Math.min(lines.length, anchorEndLine + location.contextAfterLines);
    if (endLine - startLine > 79) {
        throw new Error(`${location.filePath}: resolved source location cannot span more than 80 lines`);
    }
    return {
        startLine,
        endLine,
        sourceExcerpt: lines.slice(startLine - 1, endLine).join('\n')
    };
};
